import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";
import { buildConversationEntries } from "./conversationEntries.ts";

const asItem = (value: Record<string, unknown>) => value as unknown as AgentUXTimelineItem;

test("prompt history inserts at assistant-message indices and preserves timeline order and references", () => {
  const assistant1 = asItem({ kind: "message", id: "a1", role: "assistant", text: "one" });
  const user = asItem({ kind: "message", id: "u1", role: "user", text: "user" });
  const tool = asItem({ kind: "tool", id: "t1" });
  const reasoning = asItem({ kind: "reasoning", id: "r1" });
  const assistant2 = asItem({ kind: "message", id: "a2", role: "assistant", text: "two" });
  const timeline = [assistant1, user, tool, reasoning, assistant2];

  const entries = buildConversationEntries(timeline, ["first", "second"], "fallback");
  assert.deepEqual(entries.map((entry) => entry.kind === "user" ? entry.id : entry.item.id), [
    "prompt:a1", "a1", "u1", "t1", "r1", "prompt:a2", "a2",
  ]);
  assert.deepEqual(entries.filter((entry) => entry.kind === "item").map((entry) => entry.item), timeline);
  assert.ok(entries.filter((entry) => entry.kind === "item").every((entry, index) => entry.kind === "item" && entry.item === timeline[index]));
});

test("short histories consume a slot for blank prompts and nonempty history never falls back", () => {
  const first = asItem({ kind: "message", id: "a1", role: "assistant", text: "one" });
  const second = asItem({ kind: "message", id: "a2", role: "assistant", text: "two" });
  const third = asItem({ kind: "message", id: "a3", role: "assistant", text: "three" });
  const timeline = [first, second, third];

  assert.deepEqual(buildConversationEntries(timeline, ["", "second"], "fallback").map((entry) => entry.kind === "user" ? entry.prompt : entry.item.id), [
    "a1", "second", "a2", "a3",
  ]);
  assert.deepEqual(buildConversationEntries(timeline, [], "fallback").map((entry) => entry.kind === "user" ? entry.id : entry.item.id), [
    "preview-prompt", "a1", "a2", "a3",
  ]);
  assert.deepEqual(buildConversationEntries(timeline, ["one", "two", "three", "extra"], "fallback").filter((entry) => entry.kind === "user").map((entry) => entry.prompt), [
    "one", "two", "three",
  ]);
});

test("preview fallback preserves whitespace and skips only blank prompts", () => {
  const item = asItem({ kind: "message", id: "a1", role: "assistant", text: "answer" });
  assert.deepEqual(buildConversationEntries([item], undefined, "  preview text  "), [
    { kind: "user", id: "preview-prompt", prompt: "  preview text  " },
    { kind: "item", item },
  ]);
  assert.deepEqual(buildConversationEntries([item], undefined, " \t "), [
    { kind: "item", item },
  ]);
  assert.deepEqual(buildConversationEntries([], undefined, "preview"), [
    { kind: "user", id: "preview-prompt", prompt: "preview" },
  ]);
  assert.deepEqual(buildConversationEntries([], undefined, " \t "), []);
  assert.deepEqual(buildConversationEntries([], undefined, ""), []);
});
