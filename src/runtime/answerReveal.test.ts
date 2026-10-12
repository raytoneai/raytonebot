import assert from "node:assert/strict";
import test from "node:test";
import { nextRevealState } from "./answerReveal.ts";

test("blocks on screen when they appear never hide; off-screen ones reveal once when seen", () => {
  assert.equal(nextRevealState(undefined, true, true), undefined, "opening a conversation does not flash");
  assert.equal(nextRevealState(undefined, false, true), "pending");
  assert.equal(nextRevealState("pending", false, false), "pending");
  assert.equal(nextRevealState("pending", true, false), "visible");
  assert.equal(nextRevealState("visible", false, false), "visible", "scrolling away does not hide it again");
});
