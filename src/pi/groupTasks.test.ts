import assert from "node:assert/strict";
import { test } from "node:test";
import { createGroupWriteQueue, originalGroupTaskRequest, newGroupTask, retainedGroupTasks, recoverGroupTasks, settleGroupTask } from "./groupTasks.ts";
import { PiApprovalGate } from "./approvalGate.ts";

test("assignment identity rejects late results; restart requires explicit review", () => {
  const root = newGroupTask("request", "assistant", "task");
  const child = { ...newGroupTask("request", "builder", "build", root.id), status: "running" as const, runId: "native-run" };
  assert.throws(() => settleGroupTask(child, "old-run", "completed"), /Stale/);
  const complete = settleGroupTask(child, "native-run", "completed", "result");
  assert.equal(complete.parentId, root.id);
  assert.equal(complete.result, "result");
  const restored = recoverGroupTasks([root, child, complete]);
  assert.deepEqual(restored.map(t => t.status), ["needs_review", "needs_review", "completed"]);
  assert.throws(() => settleGroupTask(restored[1], "native-run", "completed"), /Stale/);
  const failedRoot = { ...newGroupTask("failed", "assistant", "old failure"), status: "failed" as const };
  const uncertain = { ...child, id: "uncertain", parentId: failedRoot.id, status: "needs_review" as const };
  const kept = retainedGroupTasks([failedRoot, uncertain, ...Array.from({ length: 20 }, () => ({ ...newGroupTask("recent", "assistant", "recent"), status: "completed" as const }))]);
  assert.ok(kept.some(t => t.id === failedRoot.id) && kept.some(t => t.id === uncertain.id));
  assert.ok(retainedGroupTasks([...Array.from({ length: 20 }, (_, i) => ({ ...newGroupTask(String(i), "assistant", "old"), status: "completed" as const })), ...restored]).some(t => t.id === root.id));
});

test("group write lease serializes members across groups and cancellation removes queued work", async () => {
  const queue = createGroupWriteQueue(), stop = new AbortController();
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const order: string[] = [];
  const a = queue(new AbortController().signal, async () => { order.push("a"); await held; });
  const b = queue(stop.signal, async () => { order.push("b"); });
  const rejected = assert.rejects(b); stop.abort(); await rejected;
  const c = queue(new AbortController().signal, async () => { order.push("c"); });
  release(); await Promise.all([a, c]); assert.deepEqual(order, ["a", "c"]);
});

test("parallel assignment read-only guard cannot be bypassed by allow-all or host tools", async () => {
  const gate = new PiApprovalGate({ cwd: "/tmp", protectedPaths: [], secretPaths: ["/tmp/secrets"] });
  gate.setMode("allow-all"); gate.setReadOnly(true);
  for (const name of ["write", "bash", "browser_open", "browser_tabs", "remember", "create_routine", "mcp__external__call"]) await assert.rejects(gate.wait("id", name, {}), /read-only/);
  await assert.rejects(gate.wait("id", "read", { path: "/tmp/secrets/key" }), /credentials/);
  await gate.wait("id", "read", { path: "brief.md" });
  gate.setReadOnly(false); await gate.wait("id", "write", { path: "brief.md" });
});


test("repeated retries resolve the original task prompt and attachments", () => {
  const original = newGroupTask("original-request", "assistant", "original");
  const originalChild = newGroupTask(original.requestId, "builder", "build", original.id);
  const retry = { ...newGroupTask("retry-request", "assistant", "retry"), retryOf: originalChild.id };
  const retryChild = newGroupTask(retry.requestId, "builder", "retry build", retry.id);
  assert.equal(originalGroupTaskRequest([original, originalChild, retry, retryChild], retryChild), "original-request");
  assert.throws(() => originalGroupTaskRequest([retry, retryChild], retryChild), /Original assignment/);
});
