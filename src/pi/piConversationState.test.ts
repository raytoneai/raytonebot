import assert from "node:assert/strict";
import { test } from "node:test";

import { appendPiConversationEvents, createEphemeralPiConversation } from "./piConversationState.ts";

const event = (type: string, runId: string) => ({ id: `${type}-${runId}`, runId, type, payload: {} }) as never;

/** The identity steering uses: the maintained field, or the newest run that started. */
const steerRunId = (conversation: { activeRunId?: string; events: readonly { type: string; runId?: string }[] }) =>
  conversation.activeRunId ?? [...conversation.events].reverse().find((entry) => entry.type === "run.started")?.runId;

test("the run in flight follows the events, so steering cannot address the previous turn", () => {
  // A reload during run A left the host's snapshot on the conversation.
  const reloaded = { ...createEphemeralPiConversation("c"), activeRunId: "run-A" };
  assert.equal(steerRunId(reloaded), "run-A");

  // A's terminal arrives: nothing is in flight any more, whatever the snapshot said.
  const afterA = appendPiConversationEvents(reloaded, [event("run.finished", "run-A")]);
  assert.equal(afterA.activeRunId, undefined);

  // The next turn is what makes its own run the one in flight.
  const afterB = appendPiConversationEvents(afterA, [event("run.started", "run-B")]);
  assert.equal(afterB.activeRunId, "run-B");
  assert.equal(steerRunId(afterB), "run-B", "the second turn's steering must not carry run A");

  // A late terminal for the earlier run cannot clear the current one.
  const late = appendPiConversationEvents(afterB, [event("run.error", "run-A")]);
  assert.equal(late.activeRunId, "run-B");
  // An error terminal of the current run does clear it.
  assert.equal(appendPiConversationEvents(late, [event("run.error", "run-B")]).activeRunId, undefined);
});

test("appending keeps one monotonic sequence and the original run ids", () => {
  const first = appendPiConversationEvents(createEphemeralPiConversation("c"), [event("run.started", "run-A"), event("text.delta", "run-A")]);
  const second = appendPiConversationEvents(first, [event("run.finished", "run-A")]);
  assert.deepEqual(second.events.map((entry) => (entry as { seq: number }).seq), [1, 2, 3]);
  assert.deepEqual(second.events.map((entry) => entry.runId), ["run-A", "run-A", "run-A"]);
});
