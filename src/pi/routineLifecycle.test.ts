import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentUXEvent } from "@agent-ux/protocol";
import { createConversationStore } from "./conversationStore.ts";
import type { PiRuntimeController } from "./piHost.ts";
import { createRoutineService, RoutineError, RoutineStore, type Routine } from "./routines.ts";

const definition = { id: "routine-lifecycle", name: "Routine lifecycle", protocol: "openai-compatible" as const,
  baseUrl: "https://models.example.test/v1", models: ["flash"], authMode: "none" as const };
const request = { title: "Lifecycle", schedule: "0 9 * * *", timezone: "UTC", instructions: "Check the task." };

const event = (type: string, runId: string | undefined, payload: Record<string, unknown>, id = `event_${type}`): AgentUXEvent => ({
  protocol: "agent-ux", version: "0.1", id, runId, seq: 1, ts: 100, type, payload,
});

type RoutineRuntime = Pick<PiRuntimeController, "configure" | "runPrompt" | "getConversation">;
type RunPromptOptions = Parameters<PiRuntimeController["runPrompt"]>[2];
type RuntimeConversation = NonNullable<ReturnType<PiRuntimeController["getConversation"]>>;

function runtime(input: {
  configure?: () => Promise<unknown>;
  runPrompt?: (onEvent: (event: AgentUXEvent) => void, signal?: AbortSignal) => Promise<void>;
  getConversation?: PiRuntimeController["getConversation"];
}): RoutineRuntime {
  return {
    configure: async () => { await input.configure?.(); return {} as never; },
    getConversation: input.getConversation ?? (() => undefined),
    runPrompt: async (_input, onEvent, options: RunPromptOptions) => input.runPrompt?.(onEvent, options?.signal),
  };
}

function fixture(dataDir: string, currentRuntime = runtime({})) {
  const service = createRoutineService({ dataDir, runtime: currentRuntime, permissionMode: "request" });
  const routine = service.create({ ...request, fromConversationId: "chat", model: { definition, model: "flash" } });
  service.update(routine.id, { enabled: true });
  return { service, id: routine.id };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "lifecycle state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("configure-pending stop cancels without failure, close/reopen does not resurrect it, and accepted disable remains non-aborting", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-lifecycle-pending-"));
  try {
    let configured = false, releaseConfigure!: () => void, promptCalls = 0;
    const configureGate = new Promise<void>((resolve) => { releaseConfigure = resolve; });
    const pending = fixture(dataDir, runtime({
      configure: async () => { configured = true; await configureGate; },
      runPrompt: async (onEvent) => { promptCalls += 1; onEvent(event("run.finished", "unused", { status: "success" })); },
    }));
    const first = pending.service.run(pending.id, "pending");
    await until(() => configured);
    pending.service.update(pending.id, { enabled: false });
    pending.service.update(pending.id, { enabled: true });
    releaseConfigure();
    await assert.rejects(first, (error: unknown) => error instanceof RoutineError && error.status === 409);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCalls, 0);
    assert.equal(pending.service.list()[0].lastRun, undefined);
    assert.equal(pending.service.list()[0].failures, 0);
    assert.equal(pending.service.list()[0].enabled, true);

    let releaseAccepted!: () => void, acceptedStarted!: () => void, acceptedSignal: AbortSignal | undefined;
    const acceptedGate = new Promise<void>((resolve) => { releaseAccepted = resolve; });
    const acceptedReady = new Promise<void>((resolve) => { acceptedStarted = resolve; });
    const acceptedRuntime = runtime({
      runPrompt: async (onEvent, signal) => {
        acceptedSignal = signal;
        onEvent(event("run.started", "accepted-run", {})); acceptedStarted(); await acceptedGate;
        onEvent(event("run.finished", "accepted-run", { status: "success" }));
      },
    });
    const accepted = createRoutineService({ dataDir, runtime: acceptedRuntime, permissionMode: "request" });
    const acceptedRun = accepted.run(pending.id, "accepted");
    await acceptedReady;
    await acceptedRun;
    assert.ok(acceptedSignal, "accepted run receives a caller-owned signal");
    assert.equal(acceptedSignal.aborted, false);
    accepted.update(pending.id, { enabled: false });
    assert.equal(accepted.list()[0].enabled, false);
    assert.equal(acceptedSignal.aborted, false, "disabling an accepted run does not abort it");
    releaseAccepted();
    await until(() => accepted.list()[0].lastRun?.status === "success");
    assert.equal(acceptedSignal.aborted, false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("configure rejection after a pending stop is cancellation, not a routine failure", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-lifecycle-configure-reject-"));
  try {
    let configured = false, rejectConfigure!: (reason?: unknown) => void;
    const configureGate = new Promise<void>((_resolve, reject) => { rejectConfigure = reject; });
    const pending = fixture(dataDir, runtime({
      configure: async () => { configured = true; await configureGate; },
    }));
    const run = pending.service.run(pending.id, "configure-reject");
    await until(() => configured);
    pending.service.update(pending.id, { enabled: false });
    rejectConfigure(new Error("provider became unavailable"));
    await assert.rejects(run, (error: unknown) => error instanceof RoutineError && error.status === 409);
    assert.equal(pending.service.list()[0].lastRun, undefined);
    assert.equal(pending.service.list()[0].failures, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

function seedRecovery(dataDir: string, options: {
  terminal?: AgentUXEvent;
  runId?: string;
  failures?: number;
} = {}) {
  const seed = fixture(dataDir);
  const store = new RoutineStore(join(dataDir, "routines.json"));
  const routine = store.get(seed.id)!;
  const occurrenceId = "recover";
  const runId = options.runId === undefined ? `routine_${seed.id}_${occurrenceId}` : options.runId;
  const run = { occurrenceId, at: 1, status: "running" as const, ...(runId ? { runId } : {}) };
  store.put({ ...routine, failures: options.failures ?? 0, lastRun: run, history: [run], occurrences: [occurrenceId] } as Routine);
  const conversations = createConversationStore(dataDir);
  conversations.begin(routine.conversationId, "assistant", routine.title);
  if (runId) conversations.saveTurn(routine.conversationId, { runId, harness: "pi", prompt: routine.instructions });
  conversations.append(routine.conversationId, event("run.started", runId, {}));
  if (options.terminal) {
    const terminalRunId = options.terminal.runId === "placeholder" ? (runId || undefined) : options.terminal.runId;
    conversations.append(routine.conversationId, { ...options.terminal, runId: terminalRunId });
  }
  conversations.flush(routine.conversationId);
  return { id: seed.id, conversationId: routine.conversationId, runId, conversations };
}

function recoveryRuntime(conversations: ReturnType<typeof createConversationStore>, extra: (conversation: RuntimeConversation) => RuntimeConversation = (conversation) => conversation) {
  return runtime({ getConversation: (id) => {
    const conversation = conversations.get(id);
    return conversation ? extra({ ...conversation, incomplete: false }) : undefined;
  } });
}

test("startup recovery adopts a matching real terminal, resets success failures, and increments error once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-recovery-"));
  try {
    const terminal = event("run.finished", "placeholder", { status: "success" }, "real_terminal");
    const seeded = seedRecovery(dataDir, { failures: 1, terminal });
    const service = createRoutineService({ dataDir, runtime: recoveryRuntime(seeded.conversations), permissionMode: "request" });
    assert.equal(service.list()[0].lastRun?.status, "success");
    assert.equal(service.list()[0].failures, 0);
    assert.equal(service.list()[0].lastRun?.finishedAt, 100, "recovery keeps the durable terminal timestamp");
    assert.equal(service.list()[0].history?.length, 1);

    const errorDataDir = mkdtempSync(join(tmpdir(), "rtb-routine-recovery-error-"));
    try {
      const errorSeed = seedRecovery(errorDataDir, { failures: 1, terminal: event("run.error", "placeholder", { message: "real failure" }, "real_error") });
      const errorService = createRoutineService({ dataDir: errorDataDir, runtime: recoveryRuntime(errorSeed.conversations), permissionMode: "request" });
      assert.equal(errorService.list()[0].lastRun?.status, "error");
      assert.equal(errorService.list()[0].failures, 2);
      assert.equal(errorService.list()[0].enabled, false);
      assert.equal(errorService.list()[0].history?.length, 1);
      const recovered = errorService.list()[0];
      const history = recovered.history;
      assert.equal(errorService.list()[0].failures, 2, "recovery is not repeated on later list");
      assert.deepEqual(errorService.list()[0].history, history, "recovery does not append a second history entry");
    } finally { rmSync(errorDataDir, { recursive: true, force: true }); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("recovery skips synthetic cancellation, active/legacy/unreadable records, and retries after a failed save", () => {
  const cases: Array<{ name: string; seed: (dir: string) => ReturnType<typeof seedRecovery>; runtime?: (conversations: ReturnType<typeof createConversationStore>) => RoutineRuntime }> = [
    { name: "synthetic", seed: (dir) => seedRecovery(dir, { terminal: event("run.finished", "placeholder", { status: "cancelled" }, "pi_cancel_run_finished") }) },
    { name: "legacy", seed: (dir) => seedRecovery(dir, { runId: "", terminal: event("run.finished", undefined, { status: "success" }, "real_terminal") }) },
    { name: "active", seed: (dir) => seedRecovery(dir, { terminal: event("run.finished", "placeholder", { status: "success" }, "real_terminal") }), runtime: (conversations) => recoveryRuntime(conversations, (conversation) => ({ ...conversation, activeRunId: "still-active" })) },
    { name: "unreadable", seed: (dir) => seedRecovery(dir, { terminal: event("run.finished", "placeholder", { status: "success" }, "real_terminal") }), runtime: () => runtime({ getConversation: () => { throw new Error("history unavailable"); } }) },
    { name: "mismatch", seed: (dir) => seedRecovery(dir, { terminal: event("run.finished", "different-run", { status: "success" }, "real_terminal") }) },
  ];
  for (const item of cases) {
    const dataDir = mkdtempSync(join(tmpdir(), `rtb-routine-recovery-${item.name}-`));
    try {
      const seeded = item.seed(dataDir);
      const service = createRoutineService({ dataDir, runtime: item.runtime?.(seeded.conversations) ?? recoveryRuntime(seeded.conversations), permissionMode: "request" });
      assert.equal(service.list()[0].lastRun?.status, "interrupted", item.name);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }

  const retryDir = mkdtempSync(join(tmpdir(), "rtb-routine-recovery-retry-"));
  try {
    const seeded = seedRecovery(retryDir, { terminal: event("run.finished", "placeholder", { status: "success" }, "real_terminal") });
    mkdirSync(join(retryDir, "routines.json.tmp"));
    const service = createRoutineService({ dataDir: retryDir, runtime: recoveryRuntime(seeded.conversations), permissionMode: "request" });
    assert.equal(service.list()[0].lastRun?.status, "interrupted");
    assert.equal(JSON.parse(readFileSync(join(retryDir, "routines.json"), "utf8")).routines[0].lastRun.status, "running");
    rmSync(join(retryDir, "routines.json.tmp"), { recursive: true, force: true });
    assert.equal(service.list()[0].lastRun?.status, "success");
  } finally { rmSync(retryDir, { recursive: true, force: true }); }
});
