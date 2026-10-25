import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createConversationStore } from "./conversationStore.ts";
import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import { DEFAULT_PARTICIPANTS } from "./groupParticipants.ts";
import { delegationConversationPrefix } from "./groupDelegation.ts";
import type { HostTools } from "./memories.ts";
import type { GroupTask } from "./groupTasks.ts";

const groupId = "group_delegate_test";
const guest = { id: "bot_77777777-7777-7777-7777-777777777777", name: "Research", presetId: "assistant" as const };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "controlled task did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-delegate-")), store = createConversationStore(dataDir);
  store.begin(groupId, "assistant", "seed");
  store.setExtra(groupId, { group: { members: ["assistant", guest.id], hostId: "assistant", participants: [...DEFAULT_PARTICIPANTS, guest],
    introduced: ["assistant", guest.id], lines: [{ author: "user", text: "seed" }] } });
  const calls: string[] = [], released = new Map<string, () => void>(), delegatedSpecs: string[][] = [], nestedErrors: boolean[] = [];
  const accepted: { taskId: string }[] = [], rejected: string[] = [], statusResults: unknown[] = [], referencedChecks: boolean[] = [];
  let count = 1, holdMain = false, checkInvalid = false, hostTools: HostTools | undefined;
  const factory: PiBridgeFactory = async ({ sessionDir, hostTools: tools, approvalGate }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    const delegated = id.startsWith(delegationConversationPrefix(groupId));
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        calls.push(id);
        emit({ type: "message_start", message: { role: "assistant" } });
        if (delegated) {
          delegatedSpecs.push(tools!.specs.map(tool => tool.name));
          nestedErrors.push((await tools!.run("delegate_task", { memberId: "assistant", task: "nested" })).isError);
          referencedChecks.push(!(await tools!.run("search_chat_history", { conversationId: "allowed-history", query: "referenced phrase" })).isError);
          assert.ok(approvalGate.isRefused("bash", { command: "echo forbidden" }));
          assert.ok(approvalGate.isRefused("write", { path: "forbidden.txt", content: "x" }));
          await new Promise<void>(resolve => released.set(id, resolve));
          // Deliberately sends text after abort too: the host/assignment identity must reject it.
          emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private reasoning" } });
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Actual delegated result." } });
        } else {
          hostTools = tools;
          if (prompt.includes("delegate-now")) {
            if (checkInvalid) for (const memberId of ["missing", "assistant", "builder"]) {
              const denied = await tools!.run("delegate_task", { memberId, task: "inspect" });
              assert.equal(denied.isError, true); rejected.push(denied.text);
            }
            for (let i = 0; i < count; i++) {
              const result = await tools!.run("delegate_task", { memberId: guest.id, task: `Read-only inspection ${i}` });
              if (result.isError) rejected.push(result.text); else accepted.push(JSON.parse(result.text));
            }
          }
          if (prompt.includes("inspect-now")) statusResults.push(JSON.parse((await tools!.run("group_tasks", {})).text));
          if (prompt.includes("cancel-now")) {
            const cancelled = await tools!.run("group_tasks", { taskId: accepted[0].taskId, cancel: true });
            assert.equal(cancelled.isError, false); statusResults.push(JSON.parse(cancelled.text));
          }
          if (holdMain) await new Promise<void>(resolve => released.set(id, resolve));
          emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Main reply." } });
        }
        released.delete(id);
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() { released.get(id)?.(); }, dispose() { released.get(id)?.(); },
      async configure() {}, async state() { return { models: [], tools: [] }; }, async newSession() {},
    };
  };
  let controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: factory });
  const tasks = () => store.get(groupId)?.group?.tasks?.filter(task => task.kind === "delegation") ?? [];
  const request = (requestId: string, text = "delegate-now", events: AgentUXEvent[] = []) => controller.runGroupPrompt({ conversationId: groupId, requestId,
    prompt: `@Raer ${text}`, members: ["assistant", guest.id], availableBots: [...DEFAULT_PARTICIPANTS, guest] }, event => events.push(event));
  return { store, calls, released, accepted, rejected, statusResults, delegatedSpecs, nestedErrors, referencedChecks, tasks, request,
    get controller() { return controller; }, get hostTools() { return hostTools; },
    setCount(value: number) { count = value; }, setHoldMain(value: boolean) { holdMain = value; }, checkInvalid() { checkInvalid = true; },
    releaseDelegates() { for (const [id, resolve] of released) if (id.startsWith(delegationConversationPrefix(groupId))) resolve(); },
    async restart() {
      controller.dispose();
      await until(() => controller.health().activeRuns === 0);
      controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bridgeFactory: factory });
    },
    async cleanup() {
      await controller.abort(); controller.dispose();
      for (const release of released.values()) release();
      await until(() => controller.health().activeRuns === 0);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("a delegate runs independently while the group continues, then publishes one bounded separate result", async () => {
  const f = fixture();
  try {
    const parentEvents: AgentUXEvent[] = [];
    await f.request("parent", "delegate-now", parentEvents);
    assert.equal(f.accepted.length, 1, JSON.stringify({ rejected: f.rejected, tasks: f.tasks(), calls: f.calls,
      errors: parentEvents.filter(event => event.type === "run.error").map(event => event.payload) }));
    await until(() => f.released.size === 1);
    assert.equal(f.tasks()[0].status, "running", JSON.stringify({ tasks: f.tasks(), terminal: parentEvents.filter(event => ["run.finished", "run.error"].includes(event.type)), calls: f.calls }));
    assert.equal(f.controller.listConversations().find(item => item.id === groupId)?.running, false);
    assert.equal(parentEvents.filter(event => event.type === "run.finished").length, 1);
    assert.deepEqual(f.controller.listConversations().map(item => item.id), [groupId], "dedicated delegate conversation stays hidden");
    await f.request("follow-up", "inspect-now");
    assert.equal(f.tasks()[0].status, "running", "foreground metadata cannot erase or recover a live delegate");
    assert.equal((f.statusResults[0] as { tasks: GroupTask[] }).tasks[0].id, f.accepted[0].taskId);
    const count = f.store.get(groupId)!.events.length;
    f.releaseDelegates();
    await until(() => f.tasks()[0].status === "completed" && !!f.tasks()[0].notifiedAt);
    assert.equal(f.tasks()[0].result, "Actual delegated result.");
    const saved = f.controller.getConversation(groupId)!;
    assert.ok(saved.events.length > count, "eventCount advances for idle transcript refresh");
    const resultRun = `result_${f.accepted[0].taskId}`;
    assert.equal(saved.events.filter(event => event.runId === resultRun && event.type === "run.finished").length, 1);
    assert.ok(saved.events.filter(event => event.type === "text.delta" && event.runId === resultRun).every(event => !String(event.payload.delta).includes("private reasoning")));
    for (let i = 0; i < 3; i++) f.controller.getConversation(groupId);
    assert.equal(f.store.get(groupId)!.events.filter(event => event.runId === resultRun && event.type === "run.finished").length, 1);
    assert.equal(f.store.get(groupId)!.events.filter(event => event.runId === "parent" && event.type === "run.finished").length, 1);
    assert.ok(f.delegatedSpecs.every(names => !names.some(name => /delegate|group_tasks|browser|vault|remember|forget/.test(name))));
    assert.ok(f.nestedErrors.every(Boolean));
    assert.equal((await f.hostTools!.run("delegate_task", { memberId: guest.id, task: "late" })).isError, true, "tools from an ended origin cannot create work");
  } finally { await f.cleanup(); }
});

test("completion during an active foreground turn survives metadata saves and waits to publish", async () => {
  const f = fixture(); f.setHoldMain(true);
  try {
    const turn = f.request("held-parent");
    await until(() => f.released.size === 2);
    f.releaseDelegates();
    await until(() => f.tasks()[0].status === "completed");
    assert.equal(f.store.get(groupId)!.events.some(event => event.runId?.startsWith("result_assignment_")), false);
    f.released.get(`${groupId}.m.assistant`)!();
    await turn;
    assert.equal(f.tasks()[0].status, "completed");
    assert.ok(f.tasks()[0].notifiedAt);
    const events = f.store.get(groupId)!.events;
    const parentEnd = events.findIndex(event => event.runId === "held-parent" && event.type === "run.finished");
    assert.ok(events.findIndex(event => event.runId === `result_${f.tasks()[0].id}`) > parentEnd);
  } finally { await f.cleanup(); }
});

test("membership, finite limits and capacity waiting apply without marking the group busy", async () => {
  const f = fixture(); f.setCount(5); f.checkInvalid(); f.setHoldMain(true);
  try {
    const turn = f.request("limited");
    await until(() => f.accepted.length === 4 && f.rejected.length === 4);
    assert.equal(f.tasks().length, 4);
    assert.ok(f.tasks().some(task => task.status === "pending"), "capacity wait retains pending records");
    assert.ok(f.rejected.at(-1)?.includes("limit"));
    f.controller.getConversation(groupId);
    assert.ok(f.tasks().every(task => task.status === "pending" || task.status === "running"), "reload does not recover live queued work");
    f.released.get(`${groupId}.m.assistant`)!(); await turn;
    assert.equal(f.controller.listConversations().find(item => item.id === groupId)?.running, false);
    assert.equal(await f.controller.abort(), true);
    await until(() => f.tasks().every(task => task.status === "cancelled"));
    assert.ok(f.calls.filter(id => id.startsWith(delegationConversationPrefix(groupId))).length <= 3, "cancelled capacity wait never starts remaining delegates");
  } finally { await f.cleanup(); }
});

test("stopping the originating turn cancels its delegates and refuses their late successful text", async () => {
  const f = fixture(); f.setHoldMain(true);
  try {
    const turn = f.request("stop-parent");
    await until(() => f.released.size === 2);
    assert.equal(await f.controller.abort(groupId, "wrong-run"), false);
    assert.equal(f.tasks()[0].status, "running");
    assert.equal(await f.controller.abort(groupId, "stop-parent"), true);
    await turn;
    await until(() => f.tasks()[0].status === "cancelled");
    assert.doesNotMatch(f.tasks()[0].result ?? "", /Actual delegated/);
    assert.equal(f.store.get(groupId)!.events.filter(event => event.runId === "stop-parent" && event.type === "run.finished").length, 1);
  } finally { await f.cleanup(); }
});

for (const tool of [false, true]) test(`an active background task can be cancelled through ${tool ? "group_tasks" : "/task"}`, async () => {
  const f = fixture();
  try {
    await f.request("cancel-parent"); await until(() => f.released.size === 1);
    const id = f.accepted[0].taskId, before = f.calls.length;
    if (tool) await f.request("cancel-command", "cancel-now");
    else await f.controller.runGroupPrompt({ conversationId: groupId, requestId: "cancel-command", prompt: `/task ${id} cancel` }, () => {});
    assert.equal(f.tasks()[0].status, "cancelled");
    if (!tool) assert.equal(f.calls.length, before, "slash cancellation does not start a model");
    assert.doesNotMatch(f.tasks()[0].result ?? "", /Actual delegated/);
  } finally { await f.cleanup(); }
});

test("restart converts pending and running delegates to needs_review without replay", async () => {
  const f = fixture(); f.setCount(4);
  try {
    await f.request("restart-parent");
    await until(() => f.tasks().filter(task => task.status === "running").length === 3);
    assert.equal(f.tasks().filter(task => task.status === "pending").length, 1);
    const calls = f.calls.length;
    await f.restart();
    f.controller.getConversation(groupId);
    assert.equal(f.tasks().length, 4);
    assert.ok(f.tasks().every(task => task.status === "needs_review"));
    assert.equal(f.calls.length, calls);
    assert.equal(f.controller.listConversations().find(item => item.id === groupId)?.running, false);
    await assert.rejects(f.controller.runGroupPrompt({ conversationId: groupId, requestId: "retry", prompt: `/task ${f.tasks()[0].id} retry` }, () => {}), /new read-only task/);
    assert.equal(f.calls.length, calls);
  } finally { await f.cleanup(); }
});

test("group references validate before acceptance and delegates inherit only trusted saved grants", async () => {
  const f = fixture();
  try {
    const invalid = { conversationId: groupId, requestId: "invalid-ref", prompt: "@Raer delegate-now", referencedConversationIds: ["missing"] };
    await assert.rejects(f.controller.runGroupPrompt(invalid, () => {}), /unavailable/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.get(groupId)!.events.length, 0);
    f.store.begin("allowed-history", "assistant", "source");
    f.store.append("allowed-history", { type: "text.started", runId: "source", payload: { textId: "source-text", role: "user" } });
    f.store.append("allowed-history", { type: "text.delta", runId: "source", payload: { textId: "source-text", delta: "referenced phrase" } });
    await f.controller.runGroupPrompt({ ...invalid, requestId: "valid-ref", referencedConversationIds: ["allowed-history"] }, () => {});
    await until(() => f.referencedChecks.length === 1);
    assert.deepEqual(f.referencedChecks, [true]);
    assert.deepEqual(f.store.get(groupId)!.turns?.find(turn => turn.runId === "valid-ref")?.referencedConversationIds, ["allowed-history"]);
  } finally { await f.cleanup(); }
});
