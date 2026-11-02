import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createManifest } from "../../scripts/observer-manifest.mjs";
import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import { observerLogRecords } from "./observer/hostInputs.ts";
import { createObserverQueries } from "./observer/queries.ts";
import { createObserverStore } from "./observer/store.ts";
import { createRepoSnapshot } from "./observer/version.ts";
import { createRunWatchdog, type WatchdogAlert } from "./runtime/runWatchdog.ts";

const idle = 300_000;
const event = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload }) as AgentUXEvent;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("watchdog fingerprints only comparable executions, resets on progress, and bounds/deduplicates observations", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const alerts: WatchdogAlert[] = [];
  const watchdog = createRunWatchdog({ enabled: () => true, waiting: () => false, alert: value => alerts.push(value) });
  let id = 0;
  const finish = (args: unknown, status = "error", exclude = false) => {
    const toolCallId = `call-${id++}`;
    watchdog.observe(event("tool.call.started", { toolCallId, name: "read" }));
    watchdog.observe(event("tool.call.running", { toolCallId, args }));
    if (exclude) watchdog.excludeTool(toolCallId);
    watchdog.observe(event("tool.call.finished", { toolCallId, status }));
    watchdog.observe(event("tool.call.finished", { toolCallId, status }));
  };
  for (let i = 0; i < 3; i++) finish({ path: "private", a: 1 });
  finish({ path: "private", a: 1 }, "success");
  for (let i = 0; i < 3; i++) finish({ path: "private", a: 1 });
  assert.equal(alerts.length, 0);
  finish({ a: 1, path: "different" });
  finish({ a: 1, path: "private" }, "error", true);
  for (let i = 0; i < 3; i++) finish({ a: 1, path: "private" });
  assert.equal(alerts.length, 0);
  finish({ path: "private", a: 1 });
  for (let i = 0; i < 8; i++) finish({ a: 1, path: "private" });
  assert.deepEqual(alerts, [{ code: "repeated_tool_failure", tool: "read", count: 4 }]);
  for (let i = 0; i < 4; i++) { watchdog.observe(event("tool.call.finished", { toolCallId: "unknown", status: "error" })); finish(undefined); }
  t.mock.timers.tick(idle - 1); assert.equal(alerts.length, 1);
  watchdog.observe(event("text.delta", { delta: "Retrying" }));
  t.mock.timers.tick(idle - 1); assert.equal(alerts.length, 1);
  t.mock.timers.tick(1); assert.equal(alerts[1].code, "inactive_run");
  t.mock.timers.tick(idle * 2); assert.equal(alerts.length, 2);
  watchdog.dispose();

  const bounded = createRunWatchdog({ enabled: () => true, waiting: () => false, alert: value => alerts.push(value) });
  for (let i = 0; i < 140; i++) bounded.observe(event("tool.call.started", { toolCallId: `${i}`, name: "read" }));
  t.mock.timers.tick(idle * 2); assert.equal(alerts.length, 2, "overflow fails closed rather than guessing idle");
  bounded.dispose();
});

test("watchdog excludes active tools and all host waiting states, then clears on disable/termination", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let waiting = false, enabled = true;
  const alerts: WatchdogAlert[] = [];
  const watchdog = createRunWatchdog({ enabled: () => enabled, waiting: () => waiting, alert: value => alerts.push(value) });
  watchdog.observe(event("tool.call.running", { toolCallId: "unknown-long-tool", args: {} }));
  t.mock.timers.tick(idle * 3); assert.equal(alerts.length, 0);
  watchdog.observe(event("tool.call.finished", { toolCallId: "unknown-long-tool", status: "success" }));
  waiting = true;
  t.mock.timers.tick(idle * 3); assert.equal(alerts.length, 0);
  waiting = false;
  watchdog.observe(event("run.awaiting_input.resolved"));
  t.mock.timers.tick(idle - 1); assert.equal(alerts.length, 0);
  enabled = false;
  t.mock.timers.tick(1); assert.equal(alerts.length, 0);
  enabled = true;
  t.mock.timers.tick(idle * 2); assert.equal(alerts.length, 0, "disabled instance cannot revive");
  const terminal = createRunWatchdog({ enabled: () => true, waiting: () => false, alert: value => alerts.push(value) });
  terminal.observe(event("run.finished"));
  t.mock.timers.tick(idle * 2); assert.equal(alerts.length, 0);
});

test("watchdog bounds fingerprint traversal before serialization and never compares truncated inputs", t => {
  const alerts: WatchdogAlert[] = [];
  const watchdog = createRunWatchdog({ enabled: () => true, waiting: () => false, alert: value => alerts.push(value) });
  t.after(() => watchdog.dispose());
  let calls = 0;
  const finish = (args: unknown) => {
    const toolCallId = `bounded-${calls++}`;
    watchdog.observe(event("tool.call.started", { toolCallId, name: "read" }));
    watchdog.observe(event("tool.call.running", { toolCallId, args }));
    watchdog.observe(event("tool.call.finished", { toolCallId, status: "error" }));
  };
  const oversizedArray = new Array(1_000_000).fill("x");
  const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key${index}`, "x"]));
  let deep: unknown = "tail";
  for (let index = 0; index < 1000; index++) deep = { next: deep };
  const stringify = t.mock.method(JSON, "stringify");
  const descriptors = t.mock.method(Object, "getOwnPropertyDescriptor");
  for (const [name, args, maxReads] of [
    ["oversized string", { text: "x".repeat(1_000_000) }, 1],
    ["oversized array", oversizedArray, 0],
    ["wide object", wide, 2048],
    ["deep object", deep, 17],
  ] as const) {
    stringify.mock.resetCalls(); descriptors.mock.resetCalls();
    finish(args);
    const serializations = stringify.mock.callCount(), reads = descriptors.mock.callCount();
    assert.equal(serializations, 0, `${name} must be rejected before serialization`);
    assert.ok(reads <= maxReads, `${name} read ${reads} entries instead of stopping within ${maxReads}`);
  }
  let getterCalls = 0, proxyCalls = 0, toJSONCalls = 0;
  const accessor = { get text() { getterCalls++; return "value"; } };
  const proxy = new Proxy({}, { ownKeys() { proxyCalls++; return []; }, getPrototypeOf() { proxyCalls++; return Object.prototype; } });
  const custom = { toJSON() { toJSONCalls++; return {}; } };
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const args of [accessor, proxy, custom, cycle, { value: undefined }, { value: Infinity }, { value: 1n }]) finish(args);
  assert.equal(getterCalls + proxyCalls + toJSONCalls, 0, "unsupported values cannot execute user hooks");
  // Distinct suffixes past the budget must not become equal by keeping a shared prefix.
  for (let index = 0; index < 8; index++) finish({ text: `${"x".repeat(65536)}${index}` });
  assert.equal(alerts.length, 0);
  for (let index = 0; index < 4; index++) finish(index % 2 ? { b: [null, true, { y: 2, x: "ok" }], a: 1 } : { a: 1, b: [null, true, { x: "ok", y: 2 }] });
  assert.deepEqual(alerts, [{ code: "repeated_tool_failure", tool: "read", count: 4 }], "ordinary nested key order stays canonical");
});

test("controller logs bounded watchdog evidence and Observer exposes scoped logs and aggregate facts", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const root = mkdtempSync(join(tmpdir(), "rtb-watchdog-")), dataDir = join(root, "data");
  const observer = createObserverStore({ dataDir });
  observer.updateSettings(0, { enabled: true, model: { provider: "fixture", model: "selected", configRevision: "1" } }, "test");
  const ready = deferred(), release = deferred();
  let emit: (value: any) => void = () => {};
  let onUserInput!: Parameters<PiBridgeFactory>[0]["onUserInput"];
  let approvalGate!: Parameters<PiBridgeFactory>[0]["approvalGate"];
  const controller = createPiRuntimeController({ cwd: root, dataDir, observerStore: observer, bridgeFactory: async input => {
    onUserInput = input.onUserInput;
    approvalGate = input.approvalGate;
    return { subscribe(listener) { emit = listener; return () => {}; }, prompt: async () => { ready.resolve(); await release.promise; },
      abort: async () => { release.resolve(); }, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {} };
  } });
  const running = controller.runPrompt({ conversationId: "watched", requestId: "watched-run", prompt: "Observe", permissionMode: "allow-all" }, () => {});
  try {
    await ready.promise;
    for (let i = 0; i < 4; i++) {
      const args = { path: join(`${dataDir}.provider-secrets`, "PRIVATE-SECRET") };
      // CLI policy checks may precede the adapter's tool-start event.
      assert.ok(approvalGate.checkRefusal(`refused-${i}`, "read", args));
      emit({ type: "tool_execution_start", toolCallId: `refused-${i}`, toolName: "read", args });
      emit({ type: "tool_execution_end", toolCallId: `refused-${i}`, toolName: "read", isError: true, result: "PRIVATE-ERROR" });
    }
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 0);
    approvalGate.setMode("request");
    emit({ type: "tool_execution_start", toolCallId: "approval", toolName: "write", args: { path: "notes.txt" } });
    const approval = approvalGate.wait("approval", "write", { path: "notes.txt" });
    t.mock.timers.tick(idle * 2);
    assert.equal(controller.awaitingUser("watched"), true);
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 0);
    assert.equal(controller.resolveApproval("approval", "no", "watched", "watched-run"), true);
    await assert.rejects(approval, /denied/);
    emit({ type: "tool_execution_end", toolCallId: "approval", toolName: "write", isError: true, result: "Denied" });
    approvalGate.setMode("allow-all");
    for (let i = 0; i < 8; i++) {
      emit({ type: "tool_execution_start", toolCallId: `failure-${i}`, toolName: "read", args: { path: "/PRIVATE-PATH", token: "DO-NOT-LOG" } });
      emit({ type: "tool_execution_end", toolCallId: `failure-${i}`, toolName: "read", isError: true, result: "PRIVATE-ERROR" });
    }
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 1);
    emit({ type: "tool_execution_start", toolCallId: "long", toolName: "read", args: { path: "long" } });
    t.mock.timers.tick(idle * 2);
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 1);
    emit({ type: "tool_execution_end", toolCallId: "long", toolName: "read", result: "success" });
    const question = onUserInput({ toolCallId: "question", questions: [{ id: "choice", header: "Choice", question: "Choose", options: [{ label: "A", description: "First" }], multiSelect: false, allowOther: true }], signal: new AbortController().signal });
    t.mock.timers.tick(idle * 2);
    assert.equal(controller.awaitingUser("watched"), true);
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 1);
    const request = controller.getConversation("watched")!.events.find(item => item.type === "run.awaiting_input" && item.payload.requestId)!;
    controller.resolveUserInput("watched", String(request.payload.requestId), null); await question;
    t.mock.timers.tick(idle - 1);
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 1);
    t.mock.timers.tick(1);
    release.resolve(); await running;
    const records = observerLogRecords(dataDir).filter(item => item.event === "run.watchdog");
    assert.deepEqual(records.map(({ code, count, durationMs, runId, conversationId }) => ({ code, count, durationMs, runId, conversationId })), [
      { code: "repeated_tool_failure", count: 4, durationMs: undefined, runId: "watched-run", conversationId: "watched" },
      { code: "inactive_run", count: undefined, durationMs: idle, runId: "watched-run", conversationId: "watched" },
    ]);
    assert.doesNotMatch(readFileSync(join(root, "logs/runtime.jsonl"), "utf8"), /PRIVATE-PATH|DO-NOT-LOG|PRIVATE-ERROR|fingerprint/);
    t.mock.timers.tick(idle * 2);
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 2);

    const repoRoot = join(root, "repo"); mkdirSync(repoRoot); writeFileSync(join(repoRoot, "main.ts"), "export const value = 1;\n");
    const manifestPath = join(repoRoot, "OBSERVER-BUILD.json"); writeFileSync(manifestPath, JSON.stringify(createManifest(repoRoot, ["main.ts"], { buildId: "watchdog-test" })));
    const repo = createRepoSnapshot({ root: repoRoot, manifestPath });
    const queries = createObserverQueries({ store: observer, repo, conversations: () => controller.observerProjections(), logs: () => [
      ...observerLogRecords(dataDir), { event: "run.watchdog", at: Date.now(), conversationId: "out-of-scope", runId: "other", code: "inactive_run" },
    ] });
    try {
      const snapshot = observer.reserveRun({ level: "L2", requestedBy: "user_session", authorizedVia: "test", sourceScope: controller.observerProjections().map(item => item.source), repo, instructionVersion: "v1" });
      const cap = queries.createCapability(snapshot);
      const logs = await queries.execute(cap, { type: "logs" });
      assert.equal(JSON.parse(logs.content).filter((item: any) => item.event === "run.watchdog").length, 2);
      const result = await queries.execute(cap, { type: "aggregate_runs", since: Date.now() - 86400000, until: Date.now() });
      const stats = result.facts.find(item => item.kind === "run_statistics")!.value;
      assert.equal(stats.watchdogAlerts, 2); assert.equal(stats.watchdogRuns, 1);
      assert.equal(stats.repeatedToolFailures, 1); assert.equal(stats.inactiveRuns, 1);
      assert.match(String(stats.watchdogInterpretation), /signals_only/);
      assert.equal(result.evidenceRefs.filter(item => item.kind === "log" && records.some(record => record.id === item.locator.eventId)).length, 2);
    } finally { queries.dispose(); }
  } finally { release.resolve(); await running; await controller.dispose(); observer.dispose(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["off", "disable", "broken"] as const) test(`controller optional watchdog ${mode} never affects the run or leaks into its next turn`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const root = mkdtempSync(join(tmpdir(), "rtb-watchdog-off-")), dataDir = join(root, "data"), observer = createObserverStore({ dataDir });
  if (mode === "disable") observer.updateSettings(0, { enabled: true }, "test");
  if (mode === "broken") observer.settings = () => { throw new Error("storage unavailable"); };
  const ready = deferred(), release = deferred();
  const controller = createPiRuntimeController({ cwd: root, dataDir, observerStore: observer, bridgeFactory: async () => ({
    subscribe: () => () => {}, prompt: async () => { ready.resolve(); await release.promise; }, abort: async () => { release.resolve(); }, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
  }) });
  const pending = controller.runPrompt({ conversationId: "optional", prompt: "Wait" }, () => {});
  try {
    await ready.promise;
    if (mode === "disable") { t.mock.timers.tick(idle - 1); observer.updateSettings(1, { enabled: false }, "test"); observer.updateSettings(2, { enabled: true }, "test"); }
    t.mock.timers.tick(idle * 2);
    release.resolve(); await pending;
    await controller.runPrompt({ conversationId: "optional", prompt: "Next turn" }, () => {});
    t.mock.timers.tick(idle * 2);
    assert.deepEqual(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog"), []);
  } finally { release.resolve(); await pending; await controller.dispose(); observer.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("group child watchdog alerts map to the active public run and remain bounded per child", async t => {
  const root = mkdtempSync(join(tmpdir(), "rtb-watchdog-group-")), dataDir = join(root, "data");
  const observer = createObserverStore({ dataDir });
  observer.updateSettings(0, { enabled: true, model: { provider: "fixture", model: "selected", configRevision: "1" } }, "test");
  const members = [
    { id: "bot_11111111-1111-1111-1111-111111111111", name: "Alpha", presetId: "assistant" as const },
    { id: "bot_22222222-2222-2222-2222-222222222222", name: "Beta", presetId: "assistant" as const },
  ];
  const ready = deferred(), release = deferred(), calls: string[] = [];
  const controller = createPiRuntimeController({ cwd: root, dataDir, observerStore: observer, bridgeFactory: async input => {
    const childId = decodeURIComponent(input.sessionDir!.split("/").at(-1)!);
    let emit: (value: any) => void = () => {};
    return { subscribe(listener) { emit = listener; return () => {}; }, async prompt() {
      calls.push(childId);
      for (let i = 0; i < 8; i++) {
        emit({ type: "tool_execution_start", toolCallId: `failure-${i}`, toolName: "read", args: { path: "missing.txt" } });
        emit({ type: "tool_execution_end", toolCallId: `failure-${i}`, toolName: "read", isError: true, result: "Missing" });
      }
      if (childId.endsWith(members[1].id)) { ready.resolve(); await release.promise; }
    }, abort: async () => { release.resolve(); }, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {} };
  } });
  controller.setGroupMembers("group_watchdog", members.map(item => item.id), members, members[0].id);
  const running = controller.runGroupPrompt({ conversationId: "group_watchdog", requestId: "public-group-run", prompt: "@Alpha @Beta check independently", permissionMode: "allow-all" }, () => {});
  let queries: ReturnType<typeof createObserverQueries> | undefined;
  try {
    await ready.promise;
    assert.equal(controller.getConversation("group_watchdog")!.activeRunId, "public-group-run");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(id => id.startsWith("group_watchdog.m.")));
    const records = observerLogRecords(dataDir).filter(item => item.event === "run.watchdog");
    assert.equal(records.length, 2, "each child emits once despite eight identical failures");
    assert.ok(records.every(item => item.conversationId === "group_watchdog" && item.runId === "public-group-run" && item.count === 4));
    const projections = controller.observerProjections();
    assert.deepEqual(projections.map(item => item.source.conversationId), ["group_watchdog"]);
    const repoRoot = join(root, "repo"); mkdirSync(repoRoot); writeFileSync(join(repoRoot, "main.ts"), "export const value = 1;\n");
    const manifestPath = join(repoRoot, "OBSERVER-BUILD.json"); writeFileSync(manifestPath, JSON.stringify(createManifest(repoRoot, ["main.ts"], { buildId: "group-watchdog-test" })));
    const repo = createRepoSnapshot({ root: repoRoot, manifestPath });
    queries = createObserverQueries({ store: observer, repo, conversations: () => controller.observerProjections(), logs: () => [
      ...observerLogRecords(dataDir),
      { event: "run.watchdog", at: Date.now(), conversationId: "group_watchdog", runId: "wrong-run", code: "inactive_run" },
    ] });
    const snapshot = observer.reserveRun({ level: "L2", requestedBy: "user_session", authorizedVia: "test", sourceScope: projections.map(item => item.source), repo, instructionVersion: "v1" });
    const result = await queries.execute(queries.createCapability(snapshot), { type: "aggregate_runs", since: Date.now() - 86400000, until: Date.now() });
    const stats = result.facts.find(item => item.kind === "run_statistics")!.value;
    assert.equal(stats.watchdogAlerts, 2); assert.equal(stats.watchdogRuns, 1);
    assert.equal(stats.repeatedToolFailures, 2); assert.equal(stats.inactiveRuns, 0, "a different run in the same group cannot contribute evidence");
    assert.equal(stats.samples, 1); assert.equal(stats.unterminated, 1);
    const refs = result.evidenceRefs.filter(item => item.kind === "log");
    assert.equal(refs.length, 2);
    assert.ok(refs.every(item => item.locator.runId === "public-group-run" && item.source?.conversationId === "group_watchdog"));
    release.resolve(); await running;
    assert.equal(observerLogRecords(dataDir).filter(item => item.event === "run.watchdog").length, 2);
  } finally { queries?.dispose(); release.resolve(); await controller.abort("group_watchdog"); await running; await controller.dispose(); observer.dispose(); rmSync(root, { recursive: true, force: true }); }
});
