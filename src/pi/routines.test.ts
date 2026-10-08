import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { cronProblem } from "./routines.ts";
import type { RoutineView } from "./routineTypes.ts";

const definition = { id: "routine-check", name: "Routine check", protocol: "openai-compatible" as const,
  baseUrl: "https://models.example.test/v1", models: ["flash"], authMode: "required" as const, apiKeyEnvVar: "ROUTINE_CHECK_API_KEY" };
const request = { title: "Morning check", schedule: "0 9 * * 1-5", timezone: "Asia/Shanghai", instructions: "Check the release page and report changes." };

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "controlled engine did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** No model: the real host, store and HTTP routes, with an engine that can call `create_routine`. */
function engine() {
  let mode: "finish" | "hold" | "fail" | "create" = "finish";
  let failConfigure = false;
  const calls: { id: string; prompt: string }[] = [];
  const configured: { id: string; provider?: string; model?: string; apiKey?: string }[] = [];
  const created: (RoutineView | Error)[] = [];
  let release: (() => void) | undefined;
  let createFrom: Record<string, unknown> = request;
  const factory: PiBridgeFactory = async ({ sessionDir, onCreateRoutine }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        calls.push({ id, prompt });
        emit({ type: "message_start", message: { role: "assistant" } });
        if (mode === "fail") throw new Error("auth failed");
        if (mode === "hold") await new Promise<void>((resolve) => { release = resolve; });
        if (mode === "create") {
          try { created.push(await onCreateRoutine!(createFrom as typeof request)); }
          catch (error) { created.push(error as Error); }
        }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Nothing new." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() { release?.(); },
      dispose() {},
      async configure(input) {
        if (failConfigure && id.startsWith("routine-")) throw new Error("model service rejected the configuration");
        configured.push({ id, provider: input.provider, model: input.model, apiKey: input.apiKey }); },
      async newSession() {},
      async state() { return { models: [], tools: [] }; },
    };
  };
  return { factory, calls, configured, created, release: () => release?.(),
    setMode(value: typeof mode) { mode = value; }, failConfiguration(value: boolean) { failConfigure = value; }, createWith(value: Record<string, unknown>) { createFrom = value; } };
}

async function hostFor(dataDir: string, bridge: ReturnType<typeof engine>) {
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const server: Server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const list = async () => (await call("/routines")).body.routines as RoutineView[];
  const close = async () => {
    host.controller.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { host, call, list, close };
}

/** Polls the host's list until its only routine matches. */
async function routineWhere(api: Awaited<ReturnType<typeof hostFor>>, predicate: (routine: RoutineView) => boolean) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const [routine] = await api.list();
    if (routine && predicate(routine)) return routine;
    assert.ok(Date.now() < deadline, "routine did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Raer saves a routine from chat, with the turn's model service. */
async function createFromChat(api: Awaited<ReturnType<typeof hostFor>>, bridge: ReturnType<typeof engine>) {
  await api.host.controller.configure({ conversationId: "chat", providerDefinition: definition, provider: definition.id, model: "flash", apiKey: "session-only" });
  bridge.setMode("create");
  await api.host.controller.runPrompt({ conversationId: "chat", prompt: "Every weekday at 9, check the release page", provider: definition.id, model: "flash", locale: "zh" }, () => {});
  bridge.setMode("finish");
  const routine = bridge.created.at(-1);
  assert.ok(routine && !(routine instanceof Error), String(routine));
  return routine;
}

test("cron schedules are five fields within range", () => {
  for (const ok of ["0 9 * * 1-5", "*/15 * * * *", "5 9,16 * * 1-5", "0 0 1 1 0", "30 8 * * 7"]) assert.equal(cronProblem(ok), undefined, ok);
  for (const bad of ["0 9 * *", "60 9 * * *", "0 24 * * *", "0 9 0 * *", "0 9 * 13 *", "0 9 * * 8", "a 9 * * *", "5-1 * * * *", "*/0 * * * *"]) {
    assert.ok(cronProblem(bad), bad);
  }
});

test("a routine created in chat is saved switched off, with the turn's model and no secret", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-create-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    assert.equal(routine.enabled, false);
    assert.equal(routine.conversationId, `routine-${routine.id}`);
    assert.deepEqual(routine.model, { provider: definition.id, model: "flash" });
    assert.deepEqual((await api.list()).map((item) => item.id), [routine.id]);
    assert.doesNotMatch(readFileSync(join(dataDir, "routines.json"), "utf8"), /session-only/);

    bridge.createWith({ ...request, schedule: "every morning" });
    bridge.setMode("create");
    await api.host.controller.runPrompt({ conversationId: "chat", prompt: "again" }, () => {});
    assert.match(String(bridge.created.at(-1)), /five fields/);
    assert.equal((await api.list()).length, 1, "an invalid schedule saves nothing");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a scheduled occurrence runs once as Raer in the routine's conversation, also after a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-run-"));
  const bridge = engine();
  let api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "2026-10-09T09-00" })).status, 409, "off until enabled");
    assert.equal((await api.call(`/routines/${routine.id}`, "POST", { enabled: true })).body.enabled, true);

    const started = await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "2026-10-09T09-00" });
    assert.equal(started.status, 202);
    assert.equal(started.body.conversationId, routine.conversationId);
    await until(() => (bridge.calls.length === 2));
    await until(() => !api.host.controller.listConversations().find((entry) => entry.id === routine.conversationId)?.running);
    const run = bridge.calls.at(-1)!;
    assert.equal(run.id, routine.conversationId);
    assert.equal(api.host.controller.getConversation(routine.conversationId)?.title, "Morning check", "named after the routine, not its prompt");
    assert.match(run.prompt, /unattended scheduled run/);
    assert.match(run.prompt, /Check the release page and report changes\./);
    assert.deepEqual(bridge.configured.at(-1), { id: routine.conversationId, provider: definition.id, model: "flash", apiKey: undefined },
      "unattended runs use the server's key, like IM chats");
    await routineWhere(api, (item) => item.lastRun?.status === "success");

    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "2026-10-09T09-00" })).status, 409);
    await api.close();
    api = await hostFor(dataDir, bridge);
    const again = await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "2026-10-09T09-00" });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already/);
    assert.equal(bridge.calls.length, 2, "the duplicate occurrence never reached the engine");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "bad id!" })).status, 400);
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a busy routine refuses a second occurrence instead of queueing it, and a restart marks it interrupted", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-busy-"));
  const bridge = engine();
  let api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.setMode("hold");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "first" })).status, 202);
    await until(() => bridge.calls.length === 2);
    const busy = await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "second" });
    assert.equal(busy.status, 409);
    assert.equal((await api.list())[0].failures, 0, "a busy refusal is not a failure");
    assert.equal((await api.list())[0].lastRun?.status, "running");
    assert.equal(bridge.calls.length, 2);

    await api.close();
    api = await hostFor(dataDir, bridge);
    const [after] = await api.list();
    assert.equal(after.lastRun?.status, "interrupted");
    assert.equal(bridge.calls.length, 2, "an interrupted run is not replayed");
  } finally { bridge.release(); await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("two failures in a row switch a routine off with the reason; turning it on again resets the count", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-fail-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.setMode("fail");
    await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "one" });
    const once = await routineWhere(api, (item) => item.lastRun?.occurrenceId === "one" && item.lastRun.status === "error");
    assert.equal(once.enabled, true);
    assert.equal(once.failures, 1);
    await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "two" });
    const twice = await routineWhere(api, (item) => !item.enabled);
    assert.equal(twice.failures, 2);
    assert.ok(twice.disabledReason);
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "three" })).status, 409);

    const back = (await api.call(`/routines/${routine.id}`, "POST", { enabled: true })).body as RoutineView;
    assert.equal(back.failures, 0);
    assert.equal(back.disabledReason, undefined);
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a routine run cannot create routines, and a deleted routine is gone", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-delete-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.setMode("create");
    await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "self" });
    await until(() => bridge.created.length === 2);
    assert.match(String(bridge.created.at(-1)), /cannot create routines/);
    await until(() => !api.host.controller.listConversations().find((entry) => entry.id === routine.conversationId)?.running);

    assert.equal((await api.call(`/routines/${routine.id}`, "DELETE")).status, 200);
    assert.deepEqual(await api.list(), []);
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "later" })).status, 404);
    assert.equal((await api.call(`/routines/${routine.id}`, "DELETE")).status, 404);
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("without a configured model service nothing is created, and a routine without one never runs on a default model", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-model-"));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "routines.json"), JSON.stringify({ routines: [{ id: "legacy01", title: "Legacy", schedule: "0 9 * * *",
    timezone: "Asia/Shanghai", instructions: "Check.", enabled: true, createdAt: 1, conversationId: "routine-legacy01", failures: 0 }] }));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    bridge.setMode("create");
    await api.host.controller.runPrompt({ conversationId: "chat", prompt: "Every morning, check" }, () => {});
    assert.match(String(bridge.created.at(-1)), /no configured model service/);
    assert.deepEqual((await api.list()).map((routine) => routine.id), ["legacy01"]);

    const refused = await api.call("/routines/legacy01/run", "POST", { occurrenceId: "one" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /no model service/);
    assert.deepEqual(bridge.calls.map((call) => call.id), ["chat"], "the routine never reached an engine");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

for (const clear of ["delete", "reset"] as const) test(`an accepted occurrence stays done after its conversation is ${clear === "delete" ? "deleted" : "reset"}`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-ledger-"));
  const bridge = engine();
  let api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "daily-1" })).status, 202);
    await routineWhere(api, (item) => item.lastRun?.status === "success");
    if (clear === "delete") api.host.controller.deleteConversation(routine.conversationId);
    else await api.host.controller.newSession(routine.conversationId);
    assert.equal(api.host.controller.getConversation(routine.conversationId)?.turns?.length ?? 0, 0, "the conversation's own receipts are gone");

    await api.close();
    api = await hostFor(dataDir, bridge);
    const again = await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "daily-1" });
    assert.equal(again.status, 409);
    assert.equal(bridge.calls.length, 2, "the old occurrence did not run again");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "daily-2" })).status, 202, "a new occurrence still runs");
    await routineWhere(api, (item) => item.lastRun?.occurrenceId === "daily-2" && item.lastRun.status === "success");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a model configuration failure counts towards switching the routine off", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-config-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.failConfiguration(true);
    const first = await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "one" });
    assert.equal(first.status, 500);
    let [saved] = await api.list();
    assert.equal(saved.failures, 1);
    assert.equal(saved.lastRun?.status, "error");
    assert.match(saved.lastRun?.error ?? "", /rejected the configuration/);
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "two" })).status, 500);
    [saved] = await api.list();
    assert.equal(saved.enabled, false);
    assert.equal(saved.failures, 2);
    assert.match(saved.disabledReason ?? "", /rejected the configuration/);
    assert.equal(bridge.calls.length, 1, "only the creating chat turn reached the engine");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a failed disk while recording a finished run is logged and leaves the host running", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-routine-disk-"));
  // The runtime log sits beside the data directory, so keep both inside this test's own root.
  const dataDir = join(root, "data");
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.setMode("hold");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "disk" })).status, 202);
    await until(() => bridge.calls.length === 2);
    // The next write of routines.json fails: its temp path is a directory.
    mkdirSync(join(dataDir, "routines.json.tmp"));
    bridge.release();
    await until(() => !api.host.controller.listConversations().find((entry) => entry.id === routine.conversationId)?.running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
    assert.match(readFileSync(join(root, "logs", "runtime.jsonl"), "utf8"), /routine\.save_failed/);
    rmSync(join(dataDir, "routines.json.tmp"), { recursive: true });
    const [saved] = await api.list();
    assert.equal(saved.lastRun?.status, "running", "the unsaved finish is not reported as saved");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "disk" })).status, 409, "the accepted occurrence stays done");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
