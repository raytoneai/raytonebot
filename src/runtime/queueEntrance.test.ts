import assert from "node:assert/strict";
import test from "node:test";
import { appendedIds } from "./queueEntrance.ts";

test("only a grown, prefix-stable queue animates its new rows", () => {
  assert.deepEqual(appendedIds(["a"], ["a", "b"]), ["b"], "an append is the one thing that animates");
  assert.deepEqual(appendedIds(["a"], ["a", "b", "c"]), ["b", "c"], "every appended row animates once");
  assert.deepEqual(appendedIds(["a", "b"], ["a", "b", "c"]), ["c"]);
});

test("a restored queue renders settled instead of replaying the entrance", () => {
  assert.deepEqual(appendedIds([], ["a", "b"]), [], "first paint with a restored queue");
  assert.deepEqual(appendedIds([], []), [], "no queue yet");
  assert.deepEqual(appendedIds(["a", "b"], ["a", "b"]), [], "an unchanged queue never animates");
});

test("another conversation's queue is a replacement, not an append", () => {
  assert.deepEqual(appendedIds(["a", "b"], ["c", "d", "e"]), [], "shared prefix differs, so nothing is new");
  assert.deepEqual(appendedIds(["a"], ["b", "c"]), [], "grew, but the head was replaced");
});

test("a shrinking or reordered queue keeps its rows still", () => {
  assert.deepEqual(appendedIds(["a", "b"], ["a"]), [], "a submitted follow-up is a removal");
  assert.deepEqual(appendedIds(["a", "b"], ["b", "c"]), [], "same length, so the grow check stops it");
  assert.deepEqual(appendedIds(["a", "b"], ["b"]), [], "the head left without a replacement");
});
