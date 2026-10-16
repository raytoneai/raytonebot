import assert from "node:assert/strict";
import test from "node:test";
import { createQueueEntrance, queueRowEnters, queueSeen } from "./queueEntrance.ts";

// The order below is the real one: a row's ref callback reads the entrance before the effect that
// records the queue runs, so `queueRowEnters` is asked first and `queueSeen` follows.

test("a queue restored with the conversation settles, while a follow-up the user adds enters", () => {
  const entrance = createQueueEntrance();
  assert.equal(queueRowEnters(entrance, "c1", "a"), false, "the first paint is a restored queue, not an append");
  queueSeen(entrance, "c1", ["a"]);

  assert.equal(queueRowEnters(entrance, "c1", "b"), true, "the user just added this one");
  queueSeen(entrance, "c1", ["a", "b"]);
  assert.equal(queueRowEnters(entrance, "c1", "b"), false, "the echo render of that same enqueue must not decide again");
  assert.equal(queueRowEnters(entrance, "c1", "a"), false);
});

test("queueing into an empty queue enters: empty is not the same as restored", () => {
  const entrance = createQueueEntrance();
  queueSeen(entrance, "c1", []);
  assert.equal(queueRowEnters(entrance, "c1", "a"), true, "the first item added to an empty queue is still the user's append");
});

test("switching conversations settles the whole queue and still enters a later append", () => {
  const entrance = createQueueEntrance();
  queueSeen(entrance, "c1", ["a"]);
  assert.equal(queueRowEnters(entrance, "c2", "x"), false, "another conversation's restored queue is not an append");
  queueSeen(entrance, "c2", ["x", "y"]);
  assert.equal(queueRowEnters(entrance, "c2", "z"), true, "an append in the new conversation enters");
});

test("a row that left and came back does not enter a second time", () => {
  const entrance = createQueueEntrance();
  queueSeen(entrance, "c1", []);
  assert.equal(queueRowEnters(entrance, "c1", "a"), true);
  queueSeen(entrance, "c1", ["a", "b"]);
  queueSeen(entrance, "c1", ["b"]);
  assert.equal(queueRowEnters(entrance, "c1", "b"), false, "the surviving row keeps its identity");
});
