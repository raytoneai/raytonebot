import assert from "node:assert/strict";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createClaudeStreamTranslator, createCodexStreamTranslator } from "../pi/cliStreams.ts";
import { createCodexAppServer } from "../pi/codexAppServer.ts";
import { piCancelledTurnEvents } from "../pi/piCancelledTurn.ts";
import { artifactEventForReplay, refreshArtifactItems } from "./artifactContent.ts";
import { displayTaskPlans, taskPlanSnapshot } from "./taskPlan.ts";

const steps = [{ step: "Read files", status: "completed" }, { step: "Run checks", status: "in_progress" }];
const render = (adapter: ReturnType<typeof createPiEventAdapter>) => {
  // Round-trip the persisted event representation through the actual renderer.
  const events = JSON.parse(JSON.stringify(adapter.events));
  return displayTaskPlans(createAgentUXViewModel(events.map(artifactEventForReplay)), events, "zh");
};

test("native Codex plan snapshots replace in place, follow open tabs, and preserve unfinished work on stop", () => {
  const adapter = createPiEventAdapter({ runId: "run-1" });
  const protocol = createCodexAppServer({ cwd: "/tmp", prompt: "plan", signal: new AbortController().signal,
    emit: adapter.apply, onSessionId() {}, onPermission: async () => "denied" });
  const push = (line: Record<string, unknown>) => protocol.push(line, () => {});
  push({ id: "thread", result: { thread: { id: "main" } } });
  const update = (threadId: string, plan: unknown) => push({ method: "turn/plan/updated", params: { threadId, turnId: "turn-1", plan } });
  update("child", steps);
  assert.equal(adapter.events.length, 0);
  update("main", [{ step: "Old draft", status: "pending" }]);
  const first = render(adapter).timeline.find((item) => item.kind === "artifact")!;
  const tab = { id: `artifact:${first.id}`, artifactId: first.id, kind: "file" as const, title: first.title!, body: first.content };
  update("main", steps.map((step) => ({ ...step, status: step.status === "in_progress" ? "inProgress" : step.status })));
  update("main", [{ step: "Malformed", status: "unknown" }]);
  const view = render(adapter);
  assert.equal(view.timeline.filter((item) => item.kind === "artifact").length, 1);
  const current = refreshArtifactItems([tab], view.timeline)[0];
  assert.match(current.body!, /已完成 1／2/);
  assert.match(current.body!, /进行中.*Run checks/);
  assert.doesNotMatch(current.body!, /Old draft|Malformed|object Object/);
  adapter.finish("cancelled");
  const stopped = refreshArtifactItems([tab], render(adapter).timeline)[0];
  assert.match(stopped.body!, /本轮已停止/);
  assert.match(stopped.body!, /未完成.*Run checks/);
  assert.match(stopped.body!, /已完成 1／2/);
  update("main", steps.map((step) => ({ ...step, status: "completed" })));
  assert.equal(refreshArtifactItems([tab], render(adapter).timeline)[0].body, stopped.body);
  const second = createPiEventAdapter({ runId: "run-2" });
  second.apply({ type: "plan_update", plan: steps });
  assert.notEqual(render(second).timeline.find((item) => item.kind === "artifact")?.id, first.id);
  assert.equal(refreshArtifactItems([tab], render(second).timeline)[0], tab, "another run cannot replace an open plan");
  const interrupted = [...second.events, ...piCancelledTurnEvents(second.events)];
  const recovered = displayTaskPlans(createAgentUXViewModel(interrupted.map(artifactEventForReplay)), interrupted, "zh");
  assert.match(recovered.timeline.find((item) => item.kind === "artifact")!.content!, /本轮已停止/);
  assert.match(recovered.timeline.find((item) => item.kind === "artifact")!.content!, /未完成.*Run checks/);
});

test("Claude TodoWrite publishes only successful parent results; legacy Codex todos preserve reported completion", () => {
  const adapter = createPiEventAdapter({ runId: "claude" });
  const translator = createClaudeStreamTranslator(adapter.apply);
  const write = (id: string, status: string, error = false, child = false) => {
    const parent = child ? { parent_tool_use_id: "child" } : {};
    translator.push({ type: "assistant", ...parent, message: { id, content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos: [{ content: id, status }] } }] } });
    translator.push({ type: "user", ...parent, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: "receipt" }] } });
  };
  write("first", "in_progress");
  write("failed", "completed", true);
  write("child", "completed", false, true);
  const plan = render(adapter).timeline.find((item) => item.kind === "artifact")!;
  assert.match(plan.content!, /进行中.*first/);
  assert.doesNotMatch(plan.content!, /failed|child/);
  adapter.finish("error");
  assert.match(render(adapter).timeline.find((item) => item.kind === "artifact")!.content!, /本轮失败/);
  const legacy = createPiEventAdapter({ runId: "old" });
  createCodexStreamTranslator(legacy.apply).push({ type: "item.updated", item: { type: "todo_list", id: "todo", items: [{ text: "done", completed: true }, { text: "next", completed: false }] } });
  legacy.finish("success");
  assert.match(render(legacy).timeline.find((item) => item.kind === "artifact")!.content!, /已完成 1／2 · 本轮已结束/);
});

test("plan validation is bounded and multiline steps remain in their own list row", () => {
  for (const plan of [null, [null], [{ step: "", status: "pending" }], Array(101).fill(steps[0]), [{ step: "x".repeat(4001), status: "pending" }]]) {
    assert.equal(taskPlanSnapshot("r", plan), undefined);
  }
  const adapter = createPiEventAdapter({ runId: "escaping" });
  adapter.apply({ type: "plan_update", plan: [{ step: "Read `file_name.ts` (source)\n# title", status: "pending" }] });
  assert.match(render(adapter).timeline.find((item) => item.kind === "artifact")!.content!, /Read `file_name.ts` \(source\) # title/);
});

test("saved plan details show confirmed owners and unfinished blockers without inventing task execution", () => {
  const adapter = createPiEventAdapter({ runId: "dependencies" });
  const plan = [{ taskId: "1", step: "Read requirements", status: "completed" },
    { taskId: "2", step: "Verify result", status: "pending", owner: "reviewer [A]", blockedBy: ["1", "2", "2"], dependenciesPending: true }];
  adapter.apply({ type: "plan_update", plan });
  const body = render(adapter).timeline.find(item => item.kind === "artifact")!.content!;
  assert.match(body, /待开始.*#2 Verify result.*负责人：reviewer \\\[A\\\]/);
  assert.match(body, /等待前置任务：#2.*依赖变更待核对/);
  assert.doesNotMatch(body, /等待前置任务：#1|#2, #2/);
  adapter.finish("cancelled");
  assert.match(render(adapter).timeline.find(item => item.kind === "artifact")!.content!, /本轮已停止/);
  const base = { step: "Check", status: "pending" };
  for (const metadata of [{ owner: 3 }, { owner: "x".repeat(161) }, { blockedBy: [3] }, { blockedBy: [""] },
    { blockedBy: Array(101).fill("1") }, { dependenciesPending: "yes" }]) assert.equal(taskPlanSnapshot("r", [{ ...base, ...metadata }]), undefined);
});
