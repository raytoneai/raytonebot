import assert from "node:assert/strict";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { appendPiConversationEvents, createEphemeralPiConversation } from "../pi/piConversationState.ts";
import { approvalForReplay, identityEventForReplay } from "./replayIdentity.ts";
import { piCancelledTurnEvents } from "../pi/piCancelledTurn.ts";

test("saved turns with reused native tool ids retain separate tool results and file artifacts", () => {
  let conversation = createEphemeralPiConversation("reused");
  for (const runId of ["denied", "first", "second", "failed", "stopped"]) {
    const adapter = createPiEventAdapter({ runId, requiresApproval: () => true });
    adapter.startUserMessage(runId);
    adapter.apply({ type: "tool_execution_start", toolCallId: "same-id", toolName: "write", args: { path: `${runId}.md`, content: runId } });
    if (runId === "denied") adapter.resolveApproval("same-id", "no");
    else if (runId !== "stopped") {
      adapter.resolveApproval("same-id", "yes");
      adapter.apply({ type: "tool_execution_end", toolCallId: "same-id", toolName: "write", isError: runId === "failed", result: { content: [{ type: "text", text: `${runId} receipt` }] } });
    }
    if (runId !== "stopped") adapter.finish("success");
    conversation = appendPiConversationEvents(conversation, adapter.events);
  }
  conversation = appendPiConversationEvents(conversation, piCancelledTurnEvents(conversation.events));
  const original = JSON.stringify(conversation.events);
  const view = createAgentUXViewModel(replayAgentUXEvents(conversation.events.map(identityEventForReplay)));
  const tools = view.timeline.filter(item => item.kind === "tool");
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.map(tool => tool.status), ["cancelled", "success", "success", "error", "cancelled"]);
  assert.deepEqual(tools.map(tool => (tool.args as { path: string }).path), ["denied.md", "first.md", "second.md", "failed.md", "stopped.md"]);
  assert.deepEqual(tools.map(tool => approvalForReplay(tool.id, conversation.events)), ["denied", "first", "second", "failed", "stopped"].map(runId => ({ runId, toolCallId: "same-id" })));
  assert.throws(() => approvalForReplay("same-id", conversation.events), /no longer available/);
  const artifacts = view.timeline.filter(item => item.kind === "artifact");
  assert.deepEqual(artifacts.map(item => [item.title, item.content, item.uri]), [["first.md", "first", "file://first.md"], ["second.md", "second", "file://second.md"]]);
  assert.equal(JSON.stringify(conversation.events), original, "display projection leaves stored events and cursor unchanged");
});

test("new approval has no old arguments or result and run/id separators cannot collide", () => {
  let conversation = createEphemeralPiConversation("pending");
  for (const [runId, toolCallId, path] of [["run:one", "two", "old.md"], ["run", "one:two", "new.md"]]) {
    const adapter = createPiEventAdapter({ runId, requiresApproval: () => true });
    adapter.apply({ type: "tool_execution_start", toolCallId, toolName: "write", args: { path, content: path } });
    if (path === "old.md") { adapter.resolveApproval(toolCallId, "no"); adapter.finish("success"); }
    conversation = appendPiConversationEvents(conversation, adapter.events);
  }
  const tools = createAgentUXViewModel(replayAgentUXEvents(conversation.events.map(identityEventForReplay))).timeline.filter(item => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[1].status, "awaiting_approval");
  assert.equal(tools[1].result, undefined);
  assert.deepEqual(tools[1].args, { path: "new.md", content: "new.md" });
  assert.deepEqual(approvalForReplay(tools[1].id, conversation.events), { runId: "run", toolCallId: "one:two" });
});
