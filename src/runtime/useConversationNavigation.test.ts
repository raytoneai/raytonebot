import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationToResume, scopedConversations } from "./useConversationNavigation.ts";

const sessions = [
  { id: "first", title: "First", agentPreset: "assistant", createdAt: 1 },
  { id: "latest", title: "Latest", agentPreset: "assistant", createdAt: 3 },
  { id: "custom", title: "Custom", agentPreset: "assistant", createdAt: 4 },
  { id: "group_one", title: "Group", groupMembers: ["assistant", "builder"], createdAt: 5 },
  { id: "observer:one", title: "Observer", systemRole: "observer" as const, createdAt: 6 },
];
const botIds = { custom: "bot_custom" };
test("Bot navigation resumes the last visit ahead of newer activity and ignores deleted or foreign visits", () => {
  assert.equal(conversationToResume(sessions, "assistant", "first", botIds), "first");
  assert.equal(conversationToResume(sessions, "assistant", "deleted", botIds), "latest");
  assert.equal(conversationToResume(sessions, "assistant", "group_one", botIds), "latest");
  assert.equal(conversationToResume(sessions, "bot_custom", undefined, botIds), "custom");
  assert.equal(conversationToResume(sessions, "builder", undefined, botIds), undefined);
});
test("history scopes keep groups, custom Bots and Observer separate while all retains global search", () => {
  assert.deepEqual(scopedConversations(sessions, "current", "assistant", botIds).map(s => s.id), ["first", "latest"]);
  assert.deepEqual(scopedConversations(sessions, "group", "assistant", botIds).map(s => s.id), ["group_one"]);
  assert.deepEqual(scopedConversations(sessions, "current", "system:observer", botIds).map(s => s.id), ["observer:one"]);
  assert.equal(scopedConversations(sessions, "all", "assistant", botIds), sessions);
});

test("group navigation restores its last visited group instead of a single Bot or a newer group", () => {
  const withGroups = [...sessions, { id: "group_two", title: "Second group", groupMembers: ["planner", "builder"], createdAt: 10 }];
  assert.equal(conversationToResume(withGroups, "group", "group_one", botIds), "group_one");
  assert.equal(conversationToResume(withGroups, "group", "latest", botIds), "group_two");
  assert.equal(conversationToResume(withGroups, "group", "deleted", botIds), "group_two");
  assert.equal(conversationToResume(sessions.filter(s => s.id !== "group_one"), "group", undefined, botIds), undefined);
});
