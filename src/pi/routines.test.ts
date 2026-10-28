import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { createRoutineService, cronMatches, cronProblem } from "./routines.ts";
import type { RoutineView } from "./routineTypes.ts";
import { ROUTINE_HISTORY_LIMIT } from "./routineTypes.ts";

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
  let mode: "finish" | "hold" | "fail" | "create" | "ask" = "finish";
  let failConfigure = false;
  const calls: { id: string; prompt: string }[] = [];
  const configured: { id: string; provider?: string; model?: string; apiKey?: string }[] = [];
  const created: (RoutineView | Error)[] = [];
  let release: (() => void) | undefined;
  let createFrom: Record<string, unknown> = request;
  const factory: PiBridgeFactory = async ({ sessionDir, onCreateRoutine, approvalGate }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        calls.push({ id, prompt });
        emit({ type: "message_start", message: { role: "assistant" } });
        if (mode === "fail") throw new Error("auth failed");
        if (mode === "hold") await new Promise<void>((resolve) => { release = resolve; });
        // An unattended run that needs a write approved, under the host's default "request" mode.
        if (mode === "ask") await approvalGate.wait("call_ask", "write", { path: "status.txt" }, new AbortController().signal);
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
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory, routineClock: false });
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

test("cron matches the minute in the routine's own timezone", () => {
  // 2026-10-09 is a Friday; 01:00 UTC is 09:00 in Shanghai.
  const at = (iso: string) => new Date(iso);
  assert.equal(cronMatches("0 9 * * 1-5", "Asia/Shanghai", at("2026-10-09T01:00:00Z")), true);
  assert.equal(cronMatches("0 9 * * 1-5", "Asia/Shanghai", at("2026-10-09T01:01:00Z")), false);
  assert.equal(cronMatches("0 9 * * 1-5", "UTC", at("2026-10-09T01:00:00Z")), false);
  assert.equal(cronMatches("0 9 * * 1-5", "Asia/Shanghai", at("2026-10-10T01:00:00Z")), false, "Saturday");
  assert.equal(cronMatches("0 9 * * 7", "Asia/Shanghai", at("2026-10-11T01:00:00Z")), true, "7 is Sunday");
  assert.equal(cronMatches("*/15 * * * *", "UTC", at("2026-10-09T01:45:00Z")), true);
  assert.equal(cronMatches("5/20 * * * *", "UTC", at("2026-10-09T01:45:00Z")), true, "from 5, every 20");
  assert.equal(cronMatches("0 0 13 * 5", "UTC", at("2026-10-09T00:00:00Z")), true, "day and weekday: either one");
  assert.equal(cronMatches("0 0 13 * *", "UTC", at("2026-10-09T00:00:00Z")), false);
  assert.equal(cronMatches("0 0 * * *", "UTC", at("2026-10-09T00:00:59Z")), true, "any second of the minute");
});

test("the host's clock runs an enabled routine once per matching minute and never catches up", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge); // 0 9 * * 1-5, Asia/Shanghai
    let now = new Date("2026-10-09T00:58:30Z");
    const logs: Record<string, unknown>[] = [];
    // A second service over the same store, with a clock the test moves.
    const clock = () => createRoutineService({ dataDir, runtime: api.host.controller, permissionMode: "request", now: () => now,
      log: (event, fields) => logs.push({ event, ...fields }) });
    let routines = clock();
    now = new Date("2026-10-09T01:00:10Z");
    await routines.tick();
    assert.equal(bridge.calls.length, 1, "switched off: the clock leaves it alone");

    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    routines = clock();
    now = new Date("2026-10-09T00:59:40Z");
    await routines.tick();
    assert.equal(bridge.calls.length, 1, "not yet 9:00");
    now = new Date("2026-10-09T01:01:20Z"); // A late step still covers 9:00.
    await routines.tick();
    await routines.tick();
    assert.equal(bridge.calls.length, 2, "one run for the minute, however many steps see it");
    await until(() => routines.list()[0].lastRun?.status === "success");
    assert.equal(routines.list()[0].lastRun?.occurrenceId, "at-20261009T0100Z");

    // A clock restarted within 9:00 sees that minute again; the occurrence is refused.
    now = new Date("2026-10-09T01:00:50Z");
    routines = clock();
    await routines.tick();
    assert.equal(bridge.calls.length, 2);
    assert.ok(logs.some((entry) => entry.event === "routine.clock_skipped" && /already/.test(String(entry.error))));

    // Asleep over Monday 9:00, awake at 9:10: the missed run is skipped, not caught up.
    now = new Date("2026-10-12T01:10:00Z");
    await routines.tick();
    assert.equal(bridge.calls.length, 2);
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
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

test("a run held for an approval shows as waiting on the user until it is answered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-wait-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    bridge.setMode("ask");
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "wait" })).status, 202);
    const waiting = await routineWhere(api, (item) => item.lastRun?.waiting === true);
    assert.equal(waiting.lastRun?.status, "running");
    assert.equal(waiting.history?.[0].waiting, true);
    assert.equal(api.host.controller.listConversations().find((entry) => entry.id === routine.conversationId)?.awaitingUser, true);
    assert.equal(api.host.controller.listConversations().find((entry) => entry.id === "chat")?.awaitingUser, undefined);
    assert.equal(api.host.controller.resolveApproval("call_ask", "yes", routine.conversationId), true);
    const done = await routineWhere(api, (item) => item.lastRun?.status === "success");
    assert.equal(done.lastRun?.waiting, undefined);
    assert.equal(done.history?.[0].waiting, undefined);
    assert.equal(api.host.controller.awaitingUser(routine.conversationId), false);
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
    assert.equal(after.history?.[0].status, "interrupted");
    assert.equal(after.history?.[0].occurrenceId, "first");
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
    assert.deepEqual(twice.history?.map(run => [run.occurrenceId, run.status]), [["two", "error"], ["one", "error"]]);
    assert.ok(twice.history?.every(run => Boolean(run.error)));
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
    assert.equal(saved.history?.[0].status, "error");
    assert.equal(saved.history?.[0].runId, undefined, "a preflight failure has no invented message anchor");
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

test("routine definitions validate and compare revisions without changing model, identity or enabled state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-edit-"));
  const bridge = engine();
  let api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    const patch = { title: "  Afternoon check  ", instructions: "  Read the changelog.  ", schedule: "30   16 * * 1-5", timezone: "Asia/Shanghai", revision: routine.revision };
    const saved = await api.call(`/routines/${routine.id}`, "POST", patch);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.title, "Afternoon check");
    assert.equal(saved.body.instructions, "Read the changelog.");
    assert.equal(saved.body.schedule, "30 16 * * 1-5");
    assert.equal(saved.body.revision, (routine.revision ?? 0) + 1);
    assert.equal(saved.body.enabled, false);
    assert.equal(saved.body.nextRunAt, undefined);
    assert.equal(saved.body.conversationId, routine.conversationId);
    assert.equal(saved.body.botId, routine.botId);
    assert.deepEqual(saved.body.model, routine.model);
    assert.equal((await api.call(`/routines/${routine.id}`, "POST", patch)).status, 409, "stale editor must not overwrite a newer definition");
    for (const invalid of [{ title: "" }, { instructions: "" }, { schedule: "every morning" }, { timezone: "Mars/Olympus" }]) {
      assert.equal((await api.call(`/routines/${routine.id}`, "POST", { ...patch, revision: saved.body.revision, ...invalid })).status, 400);
    }
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    assert.ok(Number.isFinite((await api.list())[0].nextRunAt));
    await api.close(); api = await hostFor(dataDir, bridge);
    const [restored] = await api.list();
    assert.equal(restored.title, "Afternoon check");
    assert.equal(restored.enabled, true);
    assert.equal(restored.revision, saved.body.revision);
    assert.equal(bridge.calls.length, 1, "editing and enabling did not run the task");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("routine edits are blocked before acceptance and while running, and failed saves are atomic", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-edit-running-"));
  const bridge = engine();
  const api = await hostFor(dataDir, bridge);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const routine = await createFromChat(api, bridge);
    const service = createRoutineService({ dataDir, permissionMode: "request", runtime: {
      ...api.host.controller, configure: async input => { await gate; return api.host.controller.configure(input); },
    } });
    service.update(routine.id, { enabled: true });
    bridge.setMode("hold");
    const run = service.run(routine.id, "one");
    const patch = { ...request, title: "Changed", revision: routine.revision };
    assert.throws(() => service.update(routine.id, patch), /Stop this conversation/);
    release(); await run;
    assert.throws(() => service.update(routine.id, patch), /Stop this conversation/);
    service.update(routine.id, { enabled: false }); // Preventing future runs is still allowed.
    bridge.release();
    await until(() => service.list()[0].lastRun?.status === "success");
    mkdirSync(join(dataDir, "routines.json.tmp"));
    assert.throws(() => service.update(routine.id, patch));
    assert.equal(service.list()[0].title, routine.title);
    assert.equal(service.list()[0].revision, routine.revision);
    rmSync(join(dataDir, "routines.json.tmp"), { recursive: true });
    assert.equal(service.update(routine.id, patch).title, "Changed");
    assert.equal(service.list()[0].enabled, false);
  } finally { release(); bridge.release(); await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("routine history is bounded, persists message anchors and preserves accepted occurrence deduplication", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-history-"));
  const bridge = engine();
  let api = await hostFor(dataDir, bridge);
  try {
    const routine = await createFromChat(api, bridge);
    await api.call(`/routines/${routine.id}`, "POST", { enabled: true });
    for (let i = 0; i < ROUTINE_HISTORY_LIMIT + 2; i++) {
      assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: `run-${i}` })).status, 202);
      await routineWhere(api, item => item.lastRun?.occurrenceId === `run-${i}` && item.lastRun.status === "success");
    }
    const [saved] = await api.list();
    assert.equal(saved.history?.length, ROUTINE_HISTORY_LIMIT);
    assert.equal(saved.history?.[0].occurrenceId, `run-${ROUTINE_HISTORY_LIMIT + 1}`);
    assert.equal(saved.history?.at(-1)?.occurrenceId, "run-2");
    assert.deepEqual(saved.lastRun, saved.history?.[0]);
    assert.ok(saved.lastRun?.runId && saved.lastRun?.textId && saved.lastRun?.finishedAt);
    const events = api.host.controller.getConversation(routine.conversationId)!.events;
    assert.ok(events.some(event => event.runId === saved.lastRun?.runId && event.type === "text.started" && event.payload.textId === saved.lastRun?.textId));
    await api.close(); api = await hostFor(dataDir, bridge);
    assert.deepEqual((await api.list())[0].history, saved.history);
    assert.equal((await api.call(`/routines/${routine.id}/run`, "POST", { occurrenceId: "run-0" })).status, 409, "history truncation must not truncate deduplication");
  } finally { await api.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
