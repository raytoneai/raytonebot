import assert from "node:assert/strict";
import { test } from "node:test";
import { activityKey, conversationAttention, type ConversationActivity } from "./conversationActivity.ts";

test("only the viewed result is read; a later result and an unresolved approval stay visible", () => {
  const activity: ConversationActivity = { runId: "r1", eventId: "finished", at: 10, status: "success" };
  assert.equal(conversationAttention({ activity }), "new-result");
  const seen = activityKey(activity);
  assert.equal(conversationAttention({ activity }, seen), undefined);
  assert.equal(conversationAttention({ activity }, [seen]), undefined, "per-result receipts remain read across windows");
  assert.equal(conversationAttention({ activity: { ...activity, runId: "r2", at: 20 } }, seen), "new-result");
  assert.equal(conversationAttention({ activity, running: true, awaitingUser: true }, seen), "needs-you");
  assert.equal(conversationAttention({ activity: { ...activity, status: "error" } }), "error");
  assert.equal(conversationAttention({ activity: { ...activity, status: "cancelled" } }), undefined);
});
