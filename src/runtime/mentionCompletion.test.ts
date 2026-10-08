import assert from "node:assert/strict";
import { test } from "node:test";

import { applyMention, mentionMatches, mentionQuery } from "./mentionCompletion.ts";

const members = [{ id: "assistant", name: "Raer" }, { id: "planner", name: "Tonny" }, { id: "builder", name: "Bob" }];

test("an @ at a word boundary opens a query up to the caret; an e-mail address does not", () => {
  assert.deepEqual(mentionQuery("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionQuery("看看 @R", 5), { start: 3, end: 5, query: "R" });
  assert.deepEqual(mentionQuery("你好@to", 5), { start: 2, end: 5, query: "to" }, "Chinese text before @ is a boundary");
  assert.deepEqual(mentionQuery("@Ra 看看", 2), { start: 0, end: 3, query: "R" }, "the word continues past the caret");
  assert.equal(mentionQuery("rick@bo", 7), undefined);
  assert.equal(mentionQuery("@Raer 看看", 8), undefined, "past the word");
  assert.equal(mentionQuery("@ 看", 3), undefined);
});

test("matches are name prefixes in group order, case-insensitive, and close once a name is complete", () => {
  assert.deepEqual(mentionMatches(members, "").map((m) => m.name), ["Raer", "Tonny", "Bob"]);
  assert.deepEqual(mentionMatches(members, "r").map((m) => m.name), ["Raer"]);
  assert.deepEqual(mentionMatches(members, "TO").map((m) => m.name), ["Tonny"]);
  assert.deepEqual(mentionMatches(members, "x"), []);
  assert.deepEqual(mentionMatches(members, "raer"), [], "nothing left to complete");
  assert.deepEqual(mentionMatches([{ id: "assistant", name: "Raer" }], "R").map((m) => m.name), ["Raer"]);
});

test("picking a member completes the word and leaves one space after it", () => {
  assert.deepEqual(applyMention("@R", { start: 0, end: 2, query: "R" }, "Raer"), { text: "@Raer ", caret: 6 });
  assert.deepEqual(applyMention("看看 @T 你呢", { start: 3, end: 5, query: "T" }, "Tonny"), { text: "看看 @Tonny 你呢", caret: 10 });
  assert.deepEqual(applyMention("@Ra 看看", { start: 0, end: 3, query: "R" }, "Raer"), { text: "@Raer 看看", caret: 6 });
  assert.deepEqual(applyMention("@看看", { start: 0, end: 1, query: "" }, "Bob"), { text: "@Bob 看看", caret: 5 });
});
