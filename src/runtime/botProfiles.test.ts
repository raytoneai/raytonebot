import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOTS } from "./botAppearance.ts";
import { conversationBotId, parseBotProfiles, resolveBotProfiles, updateBotProfile, type BotProfile } from "./botProfiles.ts";
import { groupSessionHistory } from "./useSessionHistoryGroups.ts";
import { mentionMatches, applyMention } from "./mentionCompletion.ts";

const custom: BotProfile = { id: "bot_12345678-1234-1234-1234-123456789abc", presetId: "assistant", name: "  Muse  ", appearance: DEFAULT_BOTS.boy };

test("Bot profiles preserve legacy avatars until explicitly saved and keep identities separate from engines", () => {
  const empty = parseBotProfiles(null);
  assert.equal(resolveBotProfiles(empty, { woman: DEFAULT_BOTS.man })[0].appearance, DEFAULT_BOTS.man);
  const created = updateBotProfile(empty, custom);
  const renamed = updateBotProfile(created, { id: "assistant", presetId: "assistant", name: "小蕾", appearance: DEFAULT_BOTS.woman });
  const restored = resolveBotProfiles(parseBotProfiles(JSON.stringify(renamed)), { woman: DEFAULT_BOTS.man });
  assert.deepEqual(restored.map(bot => [bot.id, bot.name]), [["assistant", "小蕾"], ["planner", "Tonny"], ["builder", "Bob"], [custom.id, "Muse"]]);
  assert.deepEqual(restored[0].appearance, DEFAULT_BOTS.woman);
  assert.throws(() => updateBotProfile(created, { ...custom, presetId: "builder" }));
  assert.throws(() => updateBotProfile(created, { ...custom, id: "planner" }));
});

test("Stored profiles reject unsafe avatars, blank names, invalid engines and orphan associations", () => {
  const invalid = [null, { ...custom, name: " " }, { ...custom, name: "x".repeat(41) }, { ...custom, presetId: "shell" },
    { ...custom, appearance: { ...custom.appearance, faceColor: '<script>' } }, { ...custom, id: "__proto__" }];
  const store = parseBotProfiles(JSON.stringify({ profiles: [...invalid, custom], conversations: { a: custom.id, b: "deleted-bot", group_a: custom.id } }));
  assert.equal(store.profiles.length, 1);
  assert.deepEqual(store.conversations, { a: custom.id });
  assert.deepEqual(parseBotProfiles("{broken"), { profiles: [], conversations: {} });
});

test("Two Bots sharing Pi retain distinct history ownership through reload, rename and branches", () => {
  const saved = { ...updateBotProfile(parseBotProfiles(null), custom), conversations: { muse: custom.id, branch: custom.id } };
  const restored = parseBotProfiles(JSON.stringify(updateBotProfile(saved, { ...custom, name: "Muse II" })));
  const conversations = [
    { id: "rae", title: "Raer", agentPreset: "assistant" }, { id: "muse", title: "Muse", agentPreset: "assistant" },
    { id: "branch", title: "Branch", agentPreset: "assistant" }, { id: "group_team", title: "Team", agentPreset: "assistant" },
  ];
  assert.deepEqual(conversations.map(conversation => conversationBotId(restored, conversation)), ["assistant", custom.id, custom.id, undefined]);
  assert.deepEqual(groupSessionHistory(conversations, restored.conversations).map(group => [group.id, group.items.map(item => item.id)]),
    [["assistant", ["rae"]], [custom.id, ["muse", "branch"]], ["group", ["group_team"]]]);
});

test("Renamed group members still insert the host's stable routing handle", () => {
  const members = [{ id: "assistant", name: "小蕾", handle: "Raer" }];
  assert.deepEqual(mentionMatches(members, "ra"), members);
  assert.deepEqual(mentionMatches(members, "Raer"), []);
  assert.equal(applyMention("@", { start: 0, end: 1, query: "" }, members[0].handle).text, "@Raer ");
});
