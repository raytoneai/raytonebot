import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationSearchResults, searchResultKey } from "./useConversationSearch.ts";

test("search results preserve each message, its date and its exact target without duplicating title matches or losing drafts", () => {
  const local = [{ id: "source", title: "Same title", createdAt: 1 }, { id: "draft", title: "Unsent draft", createdAt: 30 }];
  const result = conversationSearchResults(local, [{ ...local[0], textId: "old", snippet: "old first-only client field", matches: [
    { textId: "user", snippet: "Same text", role: "user", timestamp: 10 },
    { textId: "assistant", snippet: "Same text", role: "assistant", timestamp: 20 },
  ] }, { id: "branch", title: "Same title", createdAt: 2, matches: [
    { textId: "user", snippet: "Same text", role: "user", timestamp: 10 },
  ] }]);
  assert.deepEqual(result.map(row => [row.id, row.textId, row.createdAt]), [
    ["draft", undefined, 30], ["source", "assistant", 20], ["branch", "user", 10], ["source", "user", 10],
  ]);
  assert.equal(new Set(result.map(searchResultKey)).size, 4, "inherited text IDs remain separate across conversations");
  assert.deepEqual(local[0], { id: "source", title: "Same title", createdAt: 1 }, "display dates must not change history metadata");
  assert.equal(conversationSearchResults(local).length, 2, "failed queries retain local title results");
  const legacy = conversationSearchResults([], [{ id: "old-server", title: "Legacy", textId: "only", snippet: "First result" }]);
  assert.equal(legacy[0].textId, "only", "compatible with a previous host version");
  const pages = conversationSearchResults([], [{ id: "source", title: "title", matches: [
    { textId: "one", snippet: "first", role: "user", timestamp: 10 },
  ] }, { id: "source", title: "title", matches: [
    { textId: "one", snippet: "updated", role: "user", timestamp: 10 },
    { textId: "two", snippet: "second", role: "assistant", timestamp: 9 },
  ] }]);
  assert.deepEqual(pages.map(row => [row.textId, row.snippet]), [["one", "updated"], ["two", "second"]],
    "later pages of the same conversation retain distinct hits and deduplicate overlaps");
});
