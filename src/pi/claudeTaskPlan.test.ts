import assert from "node:assert/strict";
import test from "node:test";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createClaudeStreamTranslator } from "./cliStreams.ts";
import { createClaudeTaskPlan, lastClaudeTaskPlan } from "./claudeTaskPlan.ts";
import { planTool } from "./planTool.ts";

test("Claude native receipts preserve task identity across saved turns and reject failed, child, and malformed updates", () => {
  let adapter = createPiEventAdapter({ runId: "first" });
  let translator = createClaudeStreamTranslator(adapter.apply);
  let sequence = 0;
  const call = (name: string, input: unknown, receipt: unknown, parent: string | null = null) => {
    const id = `tool_${++sequence}`;
    translator.push({ type: "assistant", parent_tool_use_id: parent, message: { id,
      content: [{ type: "tool_use", id, name, input }] } });
    translator.push({ type: "user", parent_tool_use_id: parent, tool_use_result: receipt,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "Native receipt" }] } });
  };
  const current = () => lastClaudeTaskPlan(JSON.parse(JSON.stringify(adapter.events)));
  const update = (taskId: string, to: string, success = true) => call("TaskUpdate", { taskId, status: to },
    { success, taskId, updatedFields: [to === "deleted" ? "deleted" : "status"], statusChange: { to } });
  call("TaskCreate", { subject: "Requested title" }, { task: { id: "1", subject: "Native title" } });
  call("TaskCreate", { subject: "Same title" }, { task: { id: "2", subject: "Native title" } });
  update("1", "in_progress");
  const saved = current();
  assert.deepEqual(saved?.map(({ taskId, status }) => [taskId, status]), [["1", "in_progress"], ["2", "pending"]]);
  update("1", "completed", false);
  assert.ok(adapter.events.some((event) => event.type === "tool.call.error"));
  call("TaskUpdate", { taskId: "1", status: "completed" }, { success: true, taskId: "1", updatedFields: ["status"], statusChange: { to: "completed" } }, "child");
  call("TaskList", {}, { tasks: [{ id: "1", subject: "broken", status: "unknown" }] });
  assert.deepEqual(current(), saved);

  adapter.finish("success");
  adapter = createPiEventAdapter({ runId: "resumed" });
  translator = createClaudeStreamTranslator(adapter.apply, saved);
  update("1", "completed");
  assert.deepEqual(current()?.map(({ taskId, status }) => [taskId, status]), [["1", "completed"], ["2", "pending"]]);
  call("TaskGet", { taskId: "1" }, { task: { id: "1", subject: "Confirmed", status: "completed" } });
  assert.equal(current()?.[0].step, "Confirmed", "reads must not reorder steps");
  call("TaskUpdate", { taskId: "2", subject: "Renamed" }, { success: true, taskId: "2", updatedFields: ["subject"] });
  assert.equal(current()?.[1].step, "Renamed");
  const beforeMalformed = current();
  update("unknown", "completed");
  call("TaskList", {}, { tasks: Array(101).fill({ id: "1", subject: "Too many", status: "pending" }) });
  call("TaskList", {}, { tasks: Array(2).fill({ id: "1", subject: "Duplicate", status: "pending" }) });
  assert.deepEqual(current(), beforeMalformed);
  update("2", "deleted");
  assert.deepEqual(current()?.map((step) => step.taskId), ["1"]);
  call("TaskList", {}, { tasks: [] });
  assert.deepEqual(current(), []);
  adapter.apply({ type: "plan_update", plan: [{ step: "Legacy plan", status: "pending" }] });
  assert.equal(current(), undefined, "do not resurrect an older identified plan behind a new unnumbered plan");
});

test("Pi update_plan publishes only a successful validated tool receipt, and respects cancellation", async () => {
  const adapter = createPiEventAdapter({ runId: "pi" });
  const params = { plan: [{ step: "Check result", status: "in_progress" as const }] };
  adapter.apply({ type: "tool_execution_start", toolCallId: "plan", toolName: "update_plan", args: params });
  assert.ok(!adapter.events.some((event) => event.type === "artifact.created"));
  const result = await planTool.execute("plan", params, undefined, undefined, {} as never);
  adapter.apply({ type: "tool_execution_end", toolCallId: "plan", toolName: "update_plan", result, isError: false });
  const snapshots = () => adapter.events.filter((event) => event.type === "artifact.delta");
  assert.equal(snapshots().length, 1);
  assert.deepEqual((snapshots()[0].payload.delta as { steps: unknown }).steps, params.plan);
  adapter.apply({ type: "tool_execution_end", toolCallId: "bad", toolName: "update_plan", result, isError: true });
  assert.equal(snapshots().length, 1);
  await assert.rejects(() => planTool.execute("bad", { plan: [{ step: "  ", status: "pending" }] }, undefined, undefined, {} as never), /Invalid plan/);
  await assert.rejects(() => planTool.execute("stop", params, AbortSignal.abort(), undefined, {} as never), /abort/i);
  adapter.finish("cancelled");
  adapter.apply({ type: "tool_execution_end", toolCallId: "late", toolName: "update_plan", result, isError: false });
  assert.equal(snapshots().length, 1);
});

test("Claude dependencies and owners follow native receipts, including incomplete reads and ignored dependency ids", () => {
  const update = createClaudeTaskPlan();
  const task = (id: string) => ({ id, subject: `Task ${id}`, status: "pending" });
  update("TaskList", {}, { tasks: [task("1"), task("2"), task("3")] });
  const change = (taskId: string, args: Record<string, unknown>, fields: string[]) => update("TaskUpdate", { taskId, ...args },
    { success: true, taskId, updatedFields: fields, ...(args.status ? { statusChange: { to: args.status } } : {}) });
  assert.deepEqual(change("2", { owner: "reviewer", addBlockedBy: ["1"] }, ["owner", "blockedBy"])?.[1],
    { taskId: "2", step: "Task 2", status: "pending", owner: "reviewer", blockedBy: ["1"] });
  assert.equal(update("TaskGet", {}, { task: { ...task("2"), blockedBy: ["1"], blocks: [] } })?.[1].owner, "reviewer", "TaskGet omits owner even when assigned");
  assert.deepEqual(change("1", { addBlocks: ["3"] }, ["blocks"])?.[2].blockedBy, ["1"]);
  const uncertain = change("2", { addBlockedBy: ["999", "2"] }, ["blockedBy"]);
  assert.deepEqual(uncertain?.[1].blockedBy, ["1", "2"]);
  assert.equal(uncertain?.[1].dependenciesPending, true);
  const checked = update("TaskGet", {}, { task: { ...task("2"), blockedBy: ["1", "2"] } });
  assert.equal(checked?.[1].dependenciesPending, undefined);
  assert.equal(checked?.[1].owner, "reviewer");
  const resumed = createClaudeTaskPlan(JSON.parse(JSON.stringify(checked)));
  assert.equal(resumed("TaskUpdate", { taskId: "2", owner: "" }, { success: false, taskId: "2", updatedFields: ["owner"] }), undefined);
  assert.equal(resumed("TaskUpdate", { taskId: "2", owner: "" }, { success: true, taskId: "2", updatedFields: ["owner"] })?.[1].owner, undefined);
  assert.deepEqual(change("1", { status: "deleted" }, ["deleted"])?.[1].blockedBy, undefined, "native delete clears references on other tasks");
  assert.equal(update("TaskList", {}, { tasks: [{ ...task("2"), blockedBy: [] }] })?.[0].owner, undefined, "TaskList is authoritative for unassigned owners");
  const ids = Array.from({ length: 100 }, (_, i) => String(i));
  const full = createClaudeTaskPlan(ids.map(taskId => ({ taskId, step: taskId, status: "pending", blockedBy: ids })));
  const repeated = full("TaskUpdate", { taskId: "0", owner: "worker", addBlockedBy: ids },
    { success: true, taskId: "0", updatedFields: ["owner", "blockedBy"] });
  assert.equal(repeated?.[0].owner, "worker", "re-adding existing dependencies must not discard confirmed updates at the bound");
  assert.equal(repeated?.[0].blockedBy?.length, 100);
});
