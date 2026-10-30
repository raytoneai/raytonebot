import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeViewedResults } from "./useAttentionRead.ts";

test("an old visible window cannot replace the newer result read in another window", () => {
  const older = JSON.stringify(["old", "end", 10]);
  const newer = JSON.stringify(["new", "end", 20]);
  const current = { chat: [newer, older] };
  assert.equal(mergeViewedResults(current, current, "chat", older), current);
  assert.equal(mergeViewedResults({ chat: [older] }, current, "chat", older).chat.includes(newer), true);
  assert.equal(mergeViewedResults({ chat: [older] }, { other: [newer] }, "chat", newer).other.includes(newer), true);
  const missed = JSON.stringify({ at: 30, detectedAt: 40, reason: "offline" });
  assert.equal(mergeViewedResults({ routine: [missed] }, {}, "routine", JSON.stringify({ at: 20 })).routine.includes(missed), true);
});

test("equal and backward host timestamps cannot undo another result's read state", () => {
  const a = JSON.stringify(["a", "end", 0]), b = JSON.stringify(["b", "end", 0]);
  const both = mergeViewedResults({ chat: [a] }, { chat: [b] }, "chat", a);
  assert.deepEqual(new Set(both.chat), new Set([a, b]));
  assert.equal(mergeViewedResults(both, { chat: [a] }, "chat", b), both);
  const backward = JSON.stringify(["later", "end", -10]);
  assert.ok(mergeViewedResults(both, {}, "chat", backward).chat.includes(backward));
});
