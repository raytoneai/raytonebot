import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOTS } from "./botAppearance.ts";
import { botModelConfiguration, conversationBotId, knownBotsForConversations, parseBotProfiles, resolveBotProfiles, resolveParticipantBot, updateBotProfile, type BotProfile } from "./botProfiles.ts";
import { project } from "../exported-project.ts";
import { DEFAULT_AGENT_SETTINGS } from "../pi/harnessCatalog.ts";
import { groupSessionHistory } from "./useSessionHistoryGroups.ts";
import { mentionMatches, applyMention } from "./mentionCompletion.ts";
import { applyBotRoleTemplate, botRoleTemplates } from "./botRoleTemplates.ts";

const custom: BotProfile = { id: "bot_12345678-1234-1234-1234-123456789abc", presetId: "assistant", name: "  Muse  ", appearance: DEFAULT_BOTS.boy };

test("known Bot profiles prefer current configuration and the first historical participant for duplicate IDs", () => {
  const configured = { ...custom, name: "Current name", appearance: DEFAULT_BOTS.woman };
  const planner = { id: "planner", presetId: "planner", name: "Pip", appearance: DEFAULT_BOTS.man } satisfies BotProfile;
  const configuredHistory = { ...configured, name: "Old configured name" };
  const firstHistorical = { id: "bot_72345678-1234-1234-1234-123456789abc", presetId: "planner" as const, name: "Old name" };
  const laterHistorical = { ...firstHistorical, name: "Later name" };
  const conversations = [
    { availableBots: [configuredHistory, firstHistorical], groupParticipants: [laterHistorical] },
    { groupParticipants: [{ ...laterHistorical, name: "Last name" }] },
  ];
  const before = structuredClone({ configured, planner, conversations });
  const known = knownBotsForConversations([configured, planner], conversations);

  assert.equal(known[0], configured);
  assert.equal(known[0].name, "Current name");
  assert.equal(known[0].appearance, DEFAULT_BOTS.woman);
  assert.equal(known[2].name, "Old name");
  assert.equal(known[2].appearance, DEFAULT_BOTS.man);
  assert.equal(known.length, 3);
  assert.deepEqual({ configured, planner, conversations }, before);
});

test("known Bot profiles preserve conversation and available/group participant ordering by engine", () => {
  const bots = [
    { ...custom, presetId: "assistant", name: "First assistant", appearance: DEFAULT_BOTS.woman, model: { provider: "first", model: "one" } },
    { ...custom, id: "bot_22345678-1234-1234-1234-123456789abc", presetId: "assistant", name: "Second assistant", appearance: DEFAULT_BOTS.boy },
    { ...custom, id: "planner", presetId: "planner", name: "Planner" },
  ] satisfies BotProfile[];
  const conversations = [{
    id: "group_order", title: "order", createdAt: 0, events: [],
    availableBots: [{ id: "bot_32345678-1234-1234-1234-123456789abc", presetId: "assistant" as const, name: "Available" }],
    groupParticipants: [{ id: "bot_42345678-1234-1234-1234-123456789abc", presetId: "assistant" as const, name: "Participant" }],
  }];
  const known = knownBotsForConversations(bots, conversations);
  assert.deepEqual(known.map(bot => [bot.id, bot.name]), [
    [bots[0].id, "First assistant"], [bots[1].id, "Second assistant"], ["planner", "Planner"],
    ["bot_32345678-1234-1234-1234-123456789abc", "Available"],
    ["bot_42345678-1234-1234-1234-123456789abc", "Participant"],
  ]);
  assert.equal(known[3].appearance, bots[0].appearance);
  assert.equal(known[3].model, bots[0].model);
  assert.equal(known[4].appearance, bots[0].appearance);
});

test("participant Bot resolution keeps known references and inherits the original preset fallback appearance", () => {
  const assistant = { id: "assistant", presetId: "assistant", name: "Raer", appearance: DEFAULT_BOTS.woman } satisfies BotProfile;
  const planner = { id: "planner", presetId: "planner", name: "Tonny", appearance: DEFAULT_BOTS.man } satisfies BotProfile;
  const knownBots = [assistant, planner];
  const participants = [
    { id: "bot_52345678-1234-1234-1234-123456789abc", presetId: "planner", name: "Pip" },
    { id: "bot_62345678-1234-1234-1234-123456789abc", presetId: "builder", name: "Builder" },
  ] as const;
  const before = structuredClone({ knownBots, participants });
  const known = resolveParticipantBot("assistant", knownBots, knownBots, participants);
  const inherited = resolveParticipantBot(participants[0].id, knownBots, knownBots, participants);
  const missingPreset = resolveParticipantBot(participants[1].id, [assistant], [planner], participants);

  assert.equal(known, assistant);
  assert.deepEqual(inherited, { ...planner, ...participants[0] });
  assert.notEqual(inherited, planner);
  assert.equal(inherited.appearance, planner.appearance);
  assert.deepEqual(missingPreset, { ...planner, ...participants[1] });
  assert.equal(missingPreset.appearance, planner.appearance, "missing preset keeps the first Bot fallback");
  assert.equal(resolveParticipantBot("unknown", knownBots, knownBots), assistant, "no match falls back to assistant");
  assert.equal(resolveParticipantBot("unknown", [], [planner]), planner, "missing assistant falls back to the first Bot");
  assert.deepEqual({ knownBots, participants }, before);
});

test("role starting points preserve manual text, identity, model and capability choices", () => {
  const [research, planning] = botRoleTemplates("zh");
  const draft = { ...custom, model: { provider: "existing", model: "selected" }, mcpServerIds: [], skillIds: ["chosen"] };
  const filled = applyBotRoleTemplate(draft, research.persona);
  const switched = applyBotRoleTemplate({ ...filled, role: "My own role" }, planning.persona, research.persona);
  assert.equal(switched.role, "My own role");
  assert.equal(switched.personality, planning.persona.personality);
  assert.equal(switched.instructions, planning.persona.instructions);
  for (const key of ["id", "presetId", "name", "appearance", "model", "mcpServerIds", "skillIds"] as const) assert.deepEqual(switched[key], draft[key]);
  assert.equal(filled.role, research.persona.role);
  assert.equal("role" in draft, false);
});

test("display and submission use the Bot override without changing defaults or falling back from disabled services", () => {
  const original = structuredClone(project.providers);
  const settings = { ...DEFAULT_AGENT_SETTINGS, presetId: "planner" as const, claudeCodeModelSource: "local-login" as const };
  const bot = { ...custom, presetId: "planner" as const, model: { provider: "openai", model: "bot-specific-model" } };
  const selected = botModelConfiguration(project, settings, bot);
  assert.equal(selected.providerId, "openai");
  assert.equal(selected.model, "bot-specific-model");
  assert.equal(selected.provider?.defaultModel, "bot-specific-model");
  assert.equal(selected.provider?.enabled, false, "disabled overrides remain identifiable, never silently fall back");
  assert.equal(selected.settings.claudeCodeModelSource, "provider");
  assert.equal(botModelConfiguration(project, settings, { ...bot, model: { provider: "missing", model: "missing-model" } }).provider, undefined);
  const inherited = botModelConfiguration(project, settings, custom);
  assert.equal(inherited.providerId, "deepseek");
  assert.equal(inherited.model, "deepseek-flash");
  assert.equal(inherited.settings.claudeCodeModelSource, "local-login");
  assert.deepEqual(project.providers, original);
});

test("independent persona, model and capabilities survive save/restore without changing legacy defaults", () => {
  const configured = { ...custom, role: "  Product researcher ", personality: "Direct\nand patient", instructions: "Cite primary sources.",
    model: { provider: "custom", model: "research-model" }, mcpServerIds: [], skillIds: ["research"] };
  const restored = parseBotProfiles(JSON.stringify(updateBotProfile(parseBotProfiles(null), configured)));
  const bot = restored.profiles[0];
  assert.equal(bot.role, "Product researcher");
  assert.equal(bot.personality, "Direct\nand patient");
  assert.equal(bot.instructions, "Cite primary sources.");
  assert.deepEqual(bot.model, configured.model);
  assert.deepEqual(bot.mcpServerIds, []);
  assert.equal(resolveBotProfiles(parseBotProfiles(null))[0].mcpServerIds, undefined);
  for (const bad of [{ role: "x".repeat(301) }, { personality: 42 }, { model: { provider: "", model: "x" } }, { skillIds: ["../x"] }]) {
    assert.throws(() => updateBotProfile(restored, { ...configured, ...bad } as BotProfile));
  }
});

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

test("server display caches are never reimported as legacy Bot edits", async () => {
  const { legacyBotImport } = await import("./botProfiles.ts");
  const { DEFAULT_NEW_BOT } = await import("./botAppearance.ts");
  const legacy = JSON.stringify({ profiles: [{ id: "planner", presetId: "planner", name: "tony", appearance: DEFAULT_NEW_BOT }], conversations: {} });
  const imported = legacyBotImport(legacy, null)!;
  assert.equal(imported.profiles.find(bot => bot.id === "planner")!.name, "tony");
  assert.equal(legacyBotImport(JSON.stringify({ ...imported, source: "server" }), JSON.stringify({ woman: DEFAULT_NEW_BOT })), undefined);
  assert.equal(legacyBotImport(null, null), undefined);
  assert.deepEqual(legacyBotImport(null, JSON.stringify({ woman: DEFAULT_NEW_BOT }))!.profiles[0].appearance, DEFAULT_NEW_BOT);
});
