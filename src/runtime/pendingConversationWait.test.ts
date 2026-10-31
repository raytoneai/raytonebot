import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { applyPendingConversationWait, pendingConversationWaits } from "./pendingConversationWait.ts";

const event = (type: string, runId: string | undefined, payload: Record<string, unknown> = {}, id = type): AgentUXEvent =>
  ({ type, runId, id, payload } as AgentUXEvent);

test("tracks several approval waits independently and run.error settles them", () => {
  const waits = pendingConversationWaits([
    event("tool.call.awaiting_approval", "run", { toolCallId: "first" }),
    event("tool.call.awaiting_approval", "run", { toolCallId: "second" }),
    event("tool.call.running", "run", { toolCallId: "first" }),
  ]);
  assert.equal(waits.size, 1, "settling one approval does not clear its sibling");
  applyPendingConversationWait(waits, event("run.error", "run", { message: "failed" }));
  assert.equal(waits.size, 0);
});

test("progress without an input request leaves approval pending, while a new run clears stale waits", () => {
  const waits = pendingConversationWaits([
    event("tool.call.awaiting_approval", "old-run", { toolCallId: "write" }),
  ]);
  applyPendingConversationWait(waits, event("tool.call.progress", "old-run", { toolCallId: "write" }));
  assert.equal(waits.size, 1, "progress without an input request does not settle approval");
  applyPendingConversationWait(waits, event("run.started", "new-run"));
  assert.equal(waits.size, 0, "a new turn clears stale waits before it announces its own ones");
});

test("questions, vault and channel waits resolve by their input request", () => {
  const waits = pendingConversationWaits([
    event("run.awaiting_input", "question-run", { requestId: "question" }),
    event("run.awaiting_input", "vault-run", { requestId: "vault" }),
    event("run.awaiting_input", "channel-run", { requestId: "channel" }),
  ]);
  assert.equal(waits.size, 3);
  applyPendingConversationWait(waits, event("tool.call.progress", "vault-run", { inputRequestId: "vault" }));
  assert.equal(waits.size, 2);
  applyPendingConversationWait(waits, event("tool.call.progress", "channel-run", { inputRequestId: "channel" }));
  assert.equal(waits.size, 1);
  applyPendingConversationWait(waits, event("run.finished", "question-run"));
  assert.equal(waits.size, 0);
});

test("a snapshot does not restore an already settled run", () => {
  assert.equal(pendingConversationWaits([
    event("tool.call.awaiting_approval", "old", { toolCallId: "tool" }),
    event("run.finished", "old"),
  ]).size, 0);
});
