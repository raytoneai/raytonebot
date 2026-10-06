import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";

import { createPiHttpHost, createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import { AGENT_PRESETS } from "./harnessCatalog.ts";
import { createConversationStore } from "./conversationStore.ts";
import { attachGroupChat } from "./groupChat.ts";
import { UserInputGate } from "./userInputGate.ts";

const groupId = "group_lifecycle";
const childId = `${groupId}.m.assistant`;
const input = (requestId: string) => ({ conversationId: groupId, requestId, prompt: "@Raer work", members: ["assistant"] });
const eventsFrom = (body: string) => body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as AgentUXEvent);

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "controlled engine did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** No model or CLI process: retain the real host, storage, adapter and interaction gates. */
function controlledBridges() {
  let mode: "finish" | "hold" | "fail" | "approval" | "question" = "finish";
  const calls: { id: string; prompt: string }[] = [];
  const waiting = new Set<string>();
  const release = new Map<string, () => void>();
  const aborted: string[] = [];
  const failures = new Set<string>();
  const factory: PiBridgeFactory = async ({ sessionDir, approvalGate, onUserInput }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    let stop = new AbortController();
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        calls.push({ id, prompt });
        stop = new AbortController();
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });
        if (mode === "fail" || failures.has(id)) throw new Error("controlled member failure");
        try {
          if (mode === "hold") await new Promise<void>((resolve) => { release.set(id, resolve); waiting.add(id); });
          if (mode === "approval") {
            emit({ type: "tool_execution_start", toolCallId: "same-tool", toolName: "write", args: { path: "notes.md" } });
            const approved = approvalGate.wait("same-tool", "write", { path: "notes.md" });
            waiting.add(id);
            await approved;
            emit({ type: "tool_execution_end", toolCallId: "same-tool", toolName: "write", result: { content: [{ type: "text", text: "saved" }] } });
          }
          if (mode === "question") {
            const answered = onUserInput({ toolCallId: "same-question", signal: stop.signal, questions: [{ id: "choice", header: "Choice", question: "Which one?", options: [{ label: "A", description: "First" }], multiSelect: false, allowOther: false }] });
            waiting.add(id);
            await answered;
          }
        } finally { waiting.delete(id); release.delete(id); }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " done" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() { aborted.push(id); stop.abort(); release.get(id)?.(); },
      dispose() {}, async configure() {}, async newSession() {},
      async state() { return { models: [], tools: [] }; },
    };
  };
  return { factory, calls, waiting, release, aborted, failures, setMode(value: typeof mode) { mode = value; } };
}

for (const restart of [false, true]) test(`a completed group request is not executed twice${restart ? " after a host restart" : ""}`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-dedup-"));
  const bridge = controlledBridges();
  let controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  try {
    await controller.runGroupPrompt(input("same-request"), () => {});
    const saved = controller.getConversation(groupId)!.events;
    if (restart) {
      controller.dispose();
      controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
    }
    await assert.rejects(controller.runGroupPrompt(input("same-request"), () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, 1);
    assert.deepEqual(controller.getConversation(groupId)!.events, saved, "duplicate rejection does not append another turn");
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("HTTP group stops reject an old run identity and stop only the current run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-stop-"));
  const bridge = controlledBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  const base = `${await listen(server)}/__agentcanvas/pi`;
  const stop = (runId: string) => fetch(`${base}/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: groupId, runId }) });
  let running: Promise<void> | undefined;
  try {
    await host.controller.runGroupPrompt(input("old-run"), () => {});
    bridge.setMode("hold");
    const events: AgentUXEvent[] = [];
    running = host.controller.runGroupPrompt(input("current-run"), (event) => events.push(event));
    await until(() => bridge.waiting.has(childId));
    assert.equal((await stop("old-run")).status, 409);
    assert.equal(host.controller.getConversation(groupId)?.activeRunId, "current-run");
    assert.deepEqual(bridge.aborted, []);
    assert.equal((await stop("current-run")).status, 200);
    await running;
    assert.equal(events.at(-1)?.payload.status, "cancelled");
    assert.equal((await stop("current-run")).status, 409);
  } finally {
    await host.controller.abort(groupId); await running; host.dispose(); await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a member engine failure produces a group error instead of success", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-error-"));
  const bridge = controlledBridges(); bridge.setMode("fail");
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  try {
    const events: AgentUXEvent[] = [];
    await controller.runGroupPrompt(input("failed-run"), (event) => events.push(event));
    assert.ok(controller.getConversation(childId)!.events.some((event) => event.type === "run.error"));
    const terminal = events.filter((event) => event.type === "run.error" || event.type === "run.finished");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, "run.error");
    assert.match(String(terminal[0].payload.message), /controlled member failure/);
    assert.match(String(terminal[0].payload.message), /^Raer:/);
    assert.ok(!events.some((event) => event.type === "text.delta" && String(event.payload.delta).includes("⚠️")), "the error card must not be duplicated as member text");
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(controller.getConversation(groupId)?.incomplete, false);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a terminal transport failure does not turn an accepted group into an HTTP prompt rejection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-sink-"));
  const bridge = controlledBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  let injected = false;
  const server = createServer((req, res) => {
    const write = res.write.bind(res);
    res.write = ((chunk: string, ...args: unknown[]) => {
      if (!injected && chunk.trim() && JSON.parse(chunk).type === "run.finished") {
        injected = true;
        throw new Error("terminal subscriber failed");
      }
      return Reflect.apply(write, res, [chunk, ...args]);
    }) as typeof res.write;
    void host.handle(req, res);
  });
  const base = `${await listen(server)}/__agentcanvas/pi`;
  try {
    const response = await fetch(`${base}/group/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input("sink-run")) });
    const received = eventsFrom(await response.text());
    assert.equal(injected, true);
    assert.ok(!received.some((event) => event.payload.code === "prompt_rejected"));
    const restored = await (await fetch(`${base}/conversations/${groupId}`)).json();
    assert.equal(restored.events.at(-1).type, "run.finished");
    assert.equal(restored.events.at(-1).payload.status, "success");
    await assert.rejects(host.controller.runGroupPrompt(input("sink-run"), () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, 1);
  } finally { host.dispose(); await close(server); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a failing live group subscriber is detached without affecting healthy subscribers or the engine", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-broadcast-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  let primaryCalls = 0, brokenCalls = 0;
  const running = controller.runGroupPrompt(input("broadcast-run"), () => { primaryCalls++; throw new Error("primary subscriber failed"); });
  try {
    await until(() => bridge.waiting.has(childId));
    const after = controller.getConversation(groupId)!.events.length;
    controller.followRun(groupId, after, () => { brokenCalls++; throw new Error("live subscriber failed"); });
    const healthy: AgentUXEvent[] = [];
    const follow = controller.followRun(groupId, after, (event) => healthy.push(event))!;
    bridge.release.get(childId)!();
    await Promise.all([running, follow.done]);
    assert.equal(primaryCalls, 1);
    assert.equal(brokenCalls, 1);
    assert.deepEqual(healthy, controller.getConversation(groupId)!.events.slice(after));
    assert.equal(healthy.at(-1)?.payload.status, "success");
    assert.deepEqual(bridge.aborted, []);
  } finally { await controller.abort(groupId); await running; controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

for (const [persistent, failFlush] of [[false, false], [true, false], [true, true]]) test(`unexpected group finalization failure reports one error (persistent append: ${persistent}, flush failure: ${failFlush})`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-finalize-"));
  const disk = createConversationStore(dataDir);
  let injected = 0;
  const store = { ...disk, append(id: string, event: AgentUXEvent) {
    if (id === groupId && (event.type === "run.finished" || event.type === "run.error") && (persistent || injected === 0)) {
      injected++;
      throw new Error("terminal append failed");
    }
    disk.append(id, event);
  }, flush(id: string) {
    if (id === groupId && failFlush && injected > 0) throw new Error("terminal flush failed");
    disk.flush(id);
  } };
  const bridge = controlledBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    const received: AgentUXEvent[] = [];
    await assert.doesNotReject(controller.runGroupPrompt(input("finalize-run"), (event) => received.push(event)));
    const terminals = received.filter((event) => event.type === "run.finished" || event.type === "run.error");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].payload.code, failFlush ? "history_save_failed" : "group_runtime_error");
    assert.match(String(terminals[0].payload.message), failFlush ? /terminal flush failed/ : /terminal append failed/);
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(controller.getConversation(groupId)?.incomplete, persistent);
    assert.equal(bridge.calls.length, 1);
    await assert.rejects(controller.runGroupPrompt(input("finalize-run"), () => {}), /already.*submitted/i);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a title lookup failure after group success cannot reject the completed request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-title-final-"));
  const disk = createConversationStore(dataDir);
  let failTitleRead = false, failures = 0;
  const store = { ...disk, get(id: string) {
    if (id === groupId && failTitleRead) { failTitleRead = false; failures++; throw new Error("title lookup failed"); }
    return disk.get(id);
  } };
  const bridge = controlledBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    await assert.doesNotReject(controller.runGroupPrompt(input("title-failure"), (event) => { if (event.type === "run.finished") failTitleRead = true; }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures, 1);
    assert.equal(controller.getConversation(groupId)!.events.at(-1)?.payload.status, "success");
    assert.equal(bridge.calls.length, 1);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a member error terminal without details still identifies its author", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-error-author-"));
  const store = createConversationStore(dataDir);
  const bridge = controlledBridges();
  const core = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  const controller = attachGroupChat({ ...core, async runPrompt(request, onEvent) {
    onEvent({ type: "run.finished", id: "anonymous-error", runId: request.requestId, payload: { status: "error" } } as AgentUXEvent);
  } }, { store, userInputGate: new UserInputGate(), credentials: () => undefined, providerDefinition: () => undefined, providerKey: () => undefined });
  try {
    const events: AgentUXEvent[] = [];
    await controller.runGroupPrompt(input("anonymous-failure"), (event) => events.push(event));
    assert.equal(events.at(-1)?.type, "run.error");
    assert.match(String(events.at(-1)?.payload.message), /^Raer: Member run failed\./);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("empty member engine errors remain failures with a named fallback message", async () => {
  for (const message of ["", "   "]) {
    const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-empty-error-"));
    const bridge = controlledBridges();
    const factory: PiBridgeFactory = async (context) => ({ ...await bridge.factory(context), async prompt() { throw new Error(message); } });
    const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
    try {
      const events: AgentUXEvent[] = [];
      await controller.runGroupPrompt(input("empty-error"), (event) => events.push(event));
      assert.equal(controller.getConversation(childId)!.events.at(-1)?.type, "run.error");
      assert.equal(events.at(-1)?.type, "run.error");
      assert.equal(events.at(-1)?.payload.message, "Raer: Member run failed.");
    } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("group followRun replays after the cursor then delivers live events without gaps", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-follow-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const running = controller.runGroupPrompt(input("follow-run"), () => {});
  try {
    await until(() => bridge.waiting.has(childId));
    const saved = controller.getConversation(groupId)!.events;
    const received: AgentUXEvent[] = [];
    const follow = controller.followRun(groupId, 1, (event) => received.push(event));
    assert.ok(follow, "an active group is subscribable");
    assert.deepEqual(received, saved.slice(1));
    assert.equal(controller.getConversation(groupId)?.incomplete, false, "a running group is not an interrupted conversation");
    assert.equal(controller.listConversations().find((entry) => entry.id === groupId)?.activeRunId, "follow-run");
    const leaving = controller.followRun(groupId, saved.length, () => {});
    leaving!.stop();
    bridge.release.get(childId)!();
    await Promise.all([running, follow.done]);
    assert.deepEqual(received, controller.getConversation(groupId)!.events.slice(1));
    assert.equal(received.at(-1)?.type, "run.finished");
    assert.deepEqual(bridge.aborted, []);
    assert.equal(controller.followRun(groupId, 0, () => {}), undefined);
  } finally { await controller.abort(groupId); await running; controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a disconnected group prompt reconnects through HTTP /live while waiting for user input", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-live-"));
  const bridge = controlledBridges(); bridge.setMode("question");
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  const base = `${await listen(server)}/__agentcanvas/pi`;
  const leave = new AbortController();
  try {
    const prompt = await fetch(`${base}/group/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input("http-run")), signal: leave.signal });
    await prompt.body!.getReader().read();
    await until(() => bridge.waiting.has(childId));
    leave.abort();
    const saved = host.controller.getConversation(groupId)!.events;
    const pending = saved.find((event) => event.type === "run.awaiting_input")!;
    assert.ok(pending);
    const live = await fetch(`${base}/conversations/${groupId}/live?after=1`);
    assert.equal(live.status, 200);
    const body = live.text();
    assert.equal(host.controller.resolveUserInput(groupId, pending.payload.requestId, { choice: ["A"] }), true);
    const received = eventsFrom(await body);
    assert.deepEqual(received, JSON.parse(JSON.stringify(host.controller.getConversation(groupId)!.events.slice(1))), "HTTP replay matches saved and future events after JSON serialization");
    assert.ok(received.some((event) => event.type === "run.awaiting_input"));
    assert.equal(received.at(-1)?.type, "run.finished");
    assert.deepEqual(bridge.aborted, []);
    assert.equal((await fetch(`${base}/conversations/${groupId}/live?after=0`)).status, 409);
  } finally {
    leave.abort(); await host.controller.abort(groupId); await until(() => !host.controller.getConversation(groupId)?.activeRunId);
    host.dispose(); await close(server); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTP group approval replay cannot approve a newer run reusing the native tool id", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-approval-"));
  const bridge = controlledBridges(); bridge.setMode("approval");
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  const base = `${await listen(server)}/__agentcanvas/pi`;
  const answer = (runId: string) => fetch(`${base}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: groupId, runId, toolCallId: "assistant~same-tool", decision: "yes" }) });
  let running: Promise<void> | undefined;
  try {
    running = host.controller.runGroupPrompt(input("first"), () => {});
    await until(() => bridge.waiting.has(childId));
    assert.equal((await answer("first")).status, 200); await running;
    running = host.controller.runGroupPrompt(input("second"), () => {});
    await until(() => bridge.waiting.has(childId));
    assert.equal((await answer("first")).status, 409);
    assert.equal(bridge.waiting.has(childId), true, "the current tool stays held");
    const replay: AgentUXEvent[] = [];
    const follow = host.controller.followRun(groupId, 0, (event) => replay.push(event));
    assert.ok(follow);
    assert.ok(replay.some((event) => event.runId === "second" && event.type === "tool.call.awaiting_approval"));
    assert.equal((await answer("second")).status, 200);
    await Promise.all([running, follow.done]);
    assert.equal(replay.at(-1)?.type, "run.finished");
  } finally {
    await host.controller.abort(groupId); await running; host.dispose(); await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed sequential member prevents its dependent member and the PM summary", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-sequence-"));
  const bridge = controlledBridges();
  bridge.failures.add(`${groupId}.m.planner`);
  const router = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"plan_then_build"}' } }] }));
  });
  const routerUrl = await listen(router);
  // This test file is process-isolated by node --test. Substitute controlled engines only;
  // the actual group routing, host slots, member adapters and disk records still run.
  const harnesses = AGENT_PRESETS.map((preset) => preset.harness);
  for (const preset of AGENT_PRESETS) preset.harness = "pi";
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  try {
    await controller.configure({ conversationId: "setup", provider: "router-fixture", model: "fixture",
      providerDefinition: { id: "router-fixture", name: "Router fixture", protocol: "openai-compatible", baseUrl: `${routerUrl}/v1`, models: ["fixture"], authMode: "required" } });
    const events: AgentUXEvent[] = [];
    await controller.runGroupPrompt({ conversationId: groupId, requestId: "dependent-run", prompt: "Plan then implement this task", provider: "router-fixture", model: "fixture" }, (event) => {
      events.push(event);
      if (event.type === "run.awaiting_input") {
        assert.equal(controller.resolveUserInput(groupId, event.payload.requestId, { plan: ["开始"] }), true);
      }
    });
    assert.deepEqual(bridge.calls.map((call) => call.id), [childId, `${groupId}.m.planner`], "only the PM announcement and first member execute");
    assert.equal(controller.getConversation(`${groupId}.m.builder`), undefined, "dependent implementation never starts");
    assert.equal(events.at(-1)?.type, "run.error");
    assert.equal(events.filter((event) => event.type === "run.error").length, 1);
  } finally {
    await controller.abort(groupId); controller.dispose();
    AGENT_PRESETS.forEach((preset, index) => { preset.harness = harnesses[index]; });
    await close(router); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a group request interrupted by a process restart is closed and never replayed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-interrupted-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const first = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  let restarted: ReturnType<typeof createPiRuntimeController> | undefined;
  const running = first.runGroupPrompt(input("interrupted-run"), () => {});
  try {
    await until(() => bridge.waiting.has(childId));
    // Re-open exactly what a new process would see on disk; no cleanup event from the old
    // controller is allowed to precede the recovery/read or duplicate-submission check.
    restarted = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
    const saved = restarted.getConversation(groupId)!;
    assert.equal(saved.activeRunId, undefined);
    assert.equal(saved.events.at(-1)?.type, "run.finished");
    assert.equal(saved.events.at(-1)?.payload.status, "cancelled");
    assert.equal(saved.incomplete, false);
    bridge.setMode("finish"); // A duplicate-engine regression fails promptly instead of hanging.
    await assert.rejects(restarted.runGroupPrompt(input("interrupted-run"), () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, 1);
  } finally {
    await first.abort(groupId); await running; first.dispose(); restarted?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a parallel member failure cancels siblings and retains the group until their cleanup settles", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-parallel-"));
  const started = new Set<string>(), aborting = new Set<string>();
  const releases = new Map<string, () => void>();
  let fail!: () => void, finishCleanup!: () => void;
  const failureReady = new Promise<void>((resolve) => { fail = resolve; });
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  const factory: PiBridgeFactory = async ({ sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    return {
      subscribe: () => () => {},
      async prompt() {
        started.add(id);
        if (id.endsWith(".planner")) { await failureReady; throw new Error("parallel failure"); }
        await new Promise<void>((resolve) => releases.set(id, resolve));
      },
      async abort() { aborting.add(id); await cleanup; releases.get(id)?.(); },
      async state() { return { models: [], tools: [] }; },
      async configure() {}, async newSession() {}, dispose() {},
    };
  };
  const router = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"parallel"}' } }] }));
  });
  const routerUrl = await listen(router);
  const harnesses = AGENT_PRESETS.map((preset) => preset.harness);
  for (const preset of AGENT_PRESETS) preset.harness = "pi";
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  let running: Promise<void> | undefined;
  try {
    await controller.configure({ conversationId: "setup", provider: "router-fixture", model: "fixture",
      providerDefinition: { id: "router-fixture", name: "Router fixture", protocol: "openai-compatible", baseUrl: `${routerUrl}/v1`, models: ["fixture"], authMode: "required" } });
    const events: AgentUXEvent[] = [];
    const request = { conversationId: groupId, requestId: "parallel-run", prompt: "Everyone give a separate view", provider: "router-fixture", model: "fixture" };
    running = controller.runGroupPrompt(request, (event) => events.push(event));
    await until(() => started.size === 3);
    fail();
    await until(() => aborting.size === 2);
    assert.equal(controller.getConversation(groupId)?.activeRunId, "parallel-run");
    assert.ok(!events.some((event) => event.type === "run.finished" || event.type === "run.error"), "a terminal must wait for active child cleanup");
    await assert.rejects(controller.runGroupPrompt({ ...request, requestId: "too-early" }, () => {}), /progress/);
    finishCleanup();
    await running;
    assert.equal(controller.health().activeRuns, 0);
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(events.at(-1)?.type, "run.error");
    assert.match(String(events.at(-1)?.payload.message), /parallel failure/);
    assert.equal(events.filter((event) => event.type === "run.error" || event.type === "run.finished").length, 1);
  } finally {
    fail(); finishCleanup(); await controller.abort(groupId); await running; controller.dispose();
    AGENT_PRESETS.forEach((preset, index) => { preset.harness = harnesses[index]; });
    await close(router); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a parallel group waits for capacity beside an ordinary run and executes every member once", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-capacity-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const router = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"parallel"}' } }] }));
  });
  const routerUrl = await listen(router);
  const harnesses = AGENT_PRESETS.map((preset) => preset.harness);
  for (const preset of AGENT_PRESETS) preset.harness = "pi";
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const background = controller.runPrompt({ conversationId: "background", prompt: "hold" }, () => {});
  let running: Promise<void> | undefined;
  try {
    await until(() => bridge.waiting.has("background"));
    await controller.configure({ conversationId: "setup", provider: "router-fixture", model: "fixture",
      providerDefinition: { id: "router-fixture", name: "Router fixture", protocol: "openai-compatible", baseUrl: `${routerUrl}/v1`, models: ["fixture"], authMode: "required" } });
    const events: AgentUXEvent[] = [];
    running = controller.runGroupPrompt({ conversationId: groupId, requestId: "capacity-group", prompt: "Everyone give a separate view", provider: "router-fixture", model: "fixture" }, (event) => events.push(event));
    await until(() => bridge.calls.length >= 3 || !controller.getConversation(groupId)?.activeRunId);
    assert.equal(controller.getConversation(groupId)?.activeRunId, "capacity-group");
    assert.equal(controller.health().activeRuns, 3);
    assert.equal(bridge.calls.length, 3, "one ordinary run plus two members; the third member waits");
    const firstMember = bridge.calls.find((call) => call.id !== "background")!.id;
    bridge.release.get(firstMember)!();
    await until(() => bridge.calls.length === 4);
    assert.equal(controller.health().activeRuns, 3);
    assert.ok(bridge.waiting.has("background"));
    for (const [id, release] of bridge.release) if (id !== "background") release();
    await running;
    assert.equal(events.at(-1)?.payload.status, "success");
    assert.deepEqual(bridge.calls.filter((call) => call.id !== "background").map((call) => call.id).sort(), ["assistant", "builder", "planner"].map((member) => `${groupId}.m.${member}`));
    assert.equal(controller.health().activeRuns, 1);
    assert.deepEqual(bridge.aborted, []);
  } finally {
    await controller.abort(); await Promise.allSettled([background, running]); controller.dispose();
    AGENT_PRESETS.forEach((preset, index) => { preset.harness = harnesses[index]; });
    await close(router); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stopping a group waiting for capacity leaves ordinary runs alone and never starts its member", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-capacity-stop-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const backgrounds = ["a", "b", "c"].map((conversationId) => controller.runPrompt({ conversationId, prompt: "hold" }, () => {}));
  let running: Promise<void> | undefined;
  try {
    await until(() => bridge.waiting.size === 3);
    const events: AgentUXEvent[] = [];
    running = controller.runGroupPrompt(input("capacity-stop"), (event) => events.push(event));
    await until(() => events.some((event) => event.type === "group.member.started"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getConversation(groupId)?.activeRunId, "capacity-stop");
    assert.equal(await controller.abort(groupId, "capacity-stop"), true);
    await running;
    assert.equal(events.at(-1)?.payload.status, "cancelled");
    assert.equal(bridge.calls.length, 3);
    assert.equal(controller.getConversation(childId), undefined);
    assert.equal(controller.health().activeRuns, 3);
    assert.deepEqual(bridge.aborted, []);
  } finally { await controller.abort(); await Promise.allSettled([...backgrounds, running]); controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a group waiting only for PM confirmation can reattach and answer without a live member run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-pm-follow-"));
  const bridge = controlledBridges();
  const router = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: '{"route":"plan_then_build"}' } }] }));
  });
  const routerUrl = await listen(router);
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  let running: Promise<void> | undefined;
  try {
    await controller.configure({ conversationId: "setup", provider: "router-fixture", model: "fixture",
      providerDefinition: { id: "router-fixture", name: "Router fixture", protocol: "openai-compatible", baseUrl: `${routerUrl}/v1`, models: ["fixture"], authMode: "required" } });
    running = controller.runGroupPrompt({ conversationId: groupId, requestId: "pm-run", prompt: "Plan then implement this task", provider: "router-fixture", model: "fixture" }, () => {});
    await until(() => Boolean(controller.getConversation(groupId)?.events.some((event) => event.type === "run.awaiting_input")));
    assert.equal(controller.getConversation(childId)?.activeRunId, undefined, "PM announcement is already finished");
    const saved = controller.getConversation(groupId)!.events;
    const received: AgentUXEvent[] = [];
    const follow = controller.followRun(groupId, saved.length - 1, (event) => received.push(event));
    assert.ok(follow);
    const question = received.find((event) => event.type === "run.awaiting_input")!;
    assert.ok(question, "the PM question is replayed from the parent conversation");
    assert.equal(await controller.abort(groupId, "older-pm-run"), false);
    assert.equal(controller.resolveUserInput(groupId, question.payload.requestId, { plan: ["先不做"] }), true);
    await Promise.all([running, follow.done]);
    assert.equal(received.at(-1)?.type, "run.finished");
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(bridge.calls.length, 1, "declining the plan never launches a work member");
  } finally {
    await controller.abort(groupId); await running; controller.dispose(); await close(router);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a group rejected by storage releases its slot without running a member or accepting the request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-storage-start-"));
  const bridge = controlledBridges();
  const store = createConversationStore(dataDir);
  const blocked = join(store.dir, `${groupId}.json.tmp`);
  mkdirSync(blocked);
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    await assert.rejects(controller.runGroupPrompt(input("not-accepted"), () => {}), /could not be saved/);
    assert.equal(bridge.calls.length, 0);
    assert.equal(controller.getConversation(groupId), undefined);
    assert.equal(controller.followRun(groupId, 0, () => {}), undefined);
    rmSync(blocked, { recursive: true });
    await controller.runGroupPrompt(input("not-accepted"), () => {});
    assert.equal(bridge.calls.length, 1, "an unaccepted request may be explicitly resubmitted after storage is repaired");
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("failure to save initial group metadata rejects before acceptance and allows the same request to retry", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-initial-meta-"));
  const disk = createConversationStore(dataDir);
  let fail = true;
  const store = { ...disk, setExtra(id: string, extra: Record<string, unknown>) {
    if (id === groupId && fail) { fail = false; throw new Error("initial metadata failed"); }
    disk.setExtra(id, extra);
  } };
  const bridge = controlledBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    const events: AgentUXEvent[] = [];
    await assert.rejects(controller.runGroupPrompt(input("metadata-retry"), (event) => events.push(event)), /initial metadata failed/);
    assert.equal(events.length, 0);
    assert.deepEqual(controller.getConversation(groupId)?.events, []);
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(bridge.calls.length, 0);
    await controller.runGroupPrompt(input("metadata-retry"), (event) => events.push(event));
    assert.equal(bridge.calls.length, 1);
    assert.equal(events.at(-1)?.payload.status, "success");
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

for (const existing of [false, true]) for (const fault of ["write", "rename"]) test(`a real first-receipt ${fault} failure discards rejected events and permits same-id retry (${existing ? "existing" : "new"} group)`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-receipt-disk-"));
  const store = createConversationStore(dataDir);
  const file = join(store.dir, `${groupId}.json`), backup = `${file}.previous`;
  const bridge = controlledBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  let injected = false, restored = false;
  const restore = () => {
    if (!injected || restored) return;
    rmSync(fault === "write" ? `${file}.tmp` : file, { recursive: true });
    if (fault === "rename") renameSync(backup, file);
    restored = true;
  };
  const readDisk = () => JSON.parse(readFileSync(file, "utf8")) as { events: AgentUXEvent[] };
  try {
    if (existing) await controller.runGroupPrompt(input("previous-accepted"), () => {});
    const previous = structuredClone(store.get(groupId)?.events ?? []);
    const previousCalls = bridge.calls.length;
    const request = input("receipt-retry");
    const received: AgentUXEvent[] = [];
    await controller.runGroupPrompt(request, (event) => {
      received.push(event);
      if (!injected && event.type === "text.delta" && event.messageId === `${request.requestId}_user`) {
        // Fail the real write/rename at the user-message receipt, after begin and setExtra.
        // Replacing flush() with a throw would bypass the store's cache invalidation contract.
        if (fault === "rename") renameSync(file, backup);
        mkdirSync(fault === "write" ? `${file}.tmp` : file);
        injected = true;
      }
    });
    assert.equal(injected, true);
    assert.equal(received.at(-1)?.payload.code, "prompt_rejected");
    assert.equal(bridge.calls.length, previousCalls, "a rejected receipt never reaches the engine");
    restore();
    assert.deepEqual(store.get(groupId)?.events, previous, "failed events are absent from the warm cache");
    assert.deepEqual(readDisk().events, previous, "the previous history stays authoritative");
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(controller.getConversation(groupId)?.incomplete, false);
    store.setExtra(groupId, { title: "Unrelated later save" });
    assert.deepEqual(readDisk().events, previous, "a later write cannot persist the rejected attempt");
    await controller.runGroupPrompt(request, () => {});
    assert.equal(bridge.calls.length, previousCalls + 1);
    const saved = readDisk().events;
    assert.deepEqual(saved.slice(0, previous.length), previous);
    const retried = saved.filter((event) => event.runId === request.requestId);
    assert.equal(retried.filter((event) => event.type === "text.started" && event.payload.role === "user").length, 1);
    assert.equal(retried.at(-1)?.payload.status, "success");
    await assert.rejects(controller.runGroupPrompt(request, () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, previousCalls + 1, "a successful retry remains deduplicated");
  } finally { restore(); controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("failed final group metadata produces an error before any success and releases the run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-storage-final-"));
  const bridge = controlledBridges();
  const disk = createConversationStore(dataDir);
  let metadataWrites = 0;
  const store = { ...disk, setExtra(id: string, extra: Record<string, unknown>) {
    if (id === groupId && ++metadataWrites === 2) throw new Error("final metadata could not be saved");
    disk.setExtra(id, extra);
  } };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    const received: AgentUXEvent[] = [];
    await controller.runGroupPrompt(input("metadata-failure"), (event) => received.push(event));
    const terminals = received.filter((event) => event.type === "run.finished" || event.type === "run.error");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].type, "run.error");
    assert.match(String(terminals[0].payload.message), /final metadata/);
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    assert.equal(createConversationStore(dataDir).get(groupId)?.events.at(-1)?.type, "run.error");
    await controller.runGroupPrompt(input("metadata-repaired"), () => {});
    assert.equal(bridge.calls.length, 2);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a persistent disk failure reports an accepted group's missing terminal without rejecting it as a new prompt", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-disk-final-"));
  const bridge = controlledBridges();
  const disk = createConversationStore(dataDir);
  const blocked = join(disk.dir, `${groupId}.json.tmp`);
  let writes = 0;
  const store = { ...disk, setExtra(id: string, extra: Record<string, unknown>) {
    if (id === groupId && ++writes === 2) mkdirSync(blocked);
    disk.setExtra(id, extra);
  } };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: bridge.factory });
  try {
    const events: AgentUXEvent[] = [];
    await assert.doesNotReject(controller.runGroupPrompt(input("accepted-disk-failure"), (event) => events.push(event)));
    const terminals = events.filter((event) => event.type === "run.error" || event.type === "run.finished");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].payload.code, "history_save_failed");
    assert.equal(controller.getConversation(groupId)?.incomplete, true);
    assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
    rmSync(blocked, { recursive: true });
    await assert.rejects(controller.runGroupPrompt(input("accepted-disk-failure"), () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, 1);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("newSession cannot erase an active group's accepted request and replay history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-reset-"));
  const bridge = controlledBridges(); bridge.setMode("hold");
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory });
  const running = controller.runGroupPrompt(input("accepted-run"), () => {});
  try {
    await until(() => bridge.waiting.has(childId));
    const before = structuredClone(controller.getConversation(groupId)!.events);
    await assert.rejects(controller.newSession(groupId), /Stop.*run/i);
    assert.deepEqual(controller.getConversation(groupId)!.events, before);
    assert.equal(controller.getConversation(groupId)?.activeRunId, "accepted-run");
    assert.deepEqual(bridge.aborted, []);
    bridge.release.get(childId)!();
    await running;
    await assert.rejects(controller.runGroupPrompt(input("accepted-run"), () => {}), /already.*submitted/i);
    assert.equal(bridge.calls.length, 1);
  } finally {
    await controller.abort(groupId); await running; controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a group waits for a pending session reset and does not execute if that reset fails", async () => {
  for (const fails of [false, true]) {
    const dataDir = mkdtempSync(join(tmpdir(), "rtb-group-reset-wait-"));
    const bridge = controlledBridges();
    let entered = false;
    let finish!: () => void, fail!: (error: Error) => void;
    const resetWork = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const factory: PiBridgeFactory = async (context) => {
      const session = await bridge.factory(context);
      if (decodeURIComponent(context.sessionDir!.split("/").pop()!) === groupId) {
        session.newSession = async () => { entered = true; await resetWork; };
      }
      return session;
    };
    const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
    try {
      await controller.runGroupPrompt(input("before-reset"), () => {});
      const resetting = controller.newSession(groupId);
      await until(() => entered);
      const received: AgentUXEvent[] = [];
      const queued = controller.runGroupPrompt(input("after-reset"), (event) => received.push(event));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(bridge.calls.length, 1, "no member is called while the reset is unresolved");
      assert.equal(received.length, 0, "the next group request has not been accepted yet");
      if (fails) {
        const expected = Promise.all([assert.rejects(resetting, /reset failed/), assert.rejects(queued, /reset failed/)]);
        fail(new Error("reset failed"));
        await expected;
        assert.equal(bridge.calls.length, 1);
        assert.equal(controller.getConversation(groupId)?.activeRunId, undefined);
      } else {
        finish(); await Promise.all([resetting, queued]);
        assert.equal(bridge.calls.length, 2);
        assert.equal(received.at(-1)?.type, "run.finished");
        assert.ok(controller.getConversation(groupId)?.events.some((event) => event.runId === "after-reset"));
      }
    } finally { finish(); await controller.abort(groupId); controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
  }
});
