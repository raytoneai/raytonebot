import assert from "node:assert/strict";
import test from "node:test";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { approvalRequestKey } from "./approvalSubmission.ts";
import { identityEventForReplay } from "./replayIdentity.ts";

test("dismissal identity distinguishes real approvals with reused tool ids across conversations and turns", () => {
  const run = (runId: string) => {
    const adapter = createPiEventAdapter({ runId });
    adapter.apply({ type: "tool_execution_start", toolCallId: "same-tool-id", toolName: "write", args: { path: "file.md", content: "text" } });
    adapter.requestApproval("same-tool-id");
    return adapter;
  };
  const first = run("first"), second = run("second");
  const firstEvents = first.events.map(identityEventForReplay), secondEvents = second.events.map(identityEventForReplay);
  const toolId = (events: typeof firstEvents) => events.find(event => event.type === "tool.call.awaiting_approval")!.payload.toolCallId as string;
  const old = approvalRequestKey("a", toolId(firstEvents), firstEvents);
  assert.notEqual(old, approvalRequestKey("b", toolId(firstEvents), firstEvents));
  assert.notEqual(old, approvalRequestKey("a", toolId(secondEvents), [...firstEvents, ...secondEvents]));
  first.apply({ type: "message_update", message: { id: "message", role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "unrelated text" } });
  assert.equal(old, approvalRequestKey("a", toolId(firstEvents), first.events.map(identityEventForReplay)), "unrelated streaming does not reset pending submission");
});
