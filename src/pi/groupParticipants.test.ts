import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PARTICIPANTS, participantCatalog, invitedParticipants, selectedParticipants, namedParticipants } from "./groupParticipants.ts";
import { memberPrompt, routeParticipantMessage, untag } from "./groupChat.ts";

const critic = { id: "bot_11111111-1111-1111-1111-111111111111", name: "小审", presetId: "assistant" as const };
test("invitations resolve names and never infer consent from mentions, quotes or negations", () => {
  const catalog = participantCatalog([critic]);
  for (const prompt of ["把Tonny拉进来看看问题", "邀请 Tonny 一起讨论", "add Tonny to this chat"]) assert.deepEqual(invitedParticipants(prompt, catalog).map(bot => bot.id), ["planner"]);
  assert.deepEqual(invitedParticipants("请小审来看看问题", catalog), [critic]);
  assert.deepEqual(invitedParticipants("把Tonny和Bob拉进来讨论", catalog).map(bot => bot.id), ["planner", "builder"]);
  for (const prompt of ["@Tonny 看看", "Tonny 的方案怎么样", "不要把Tonny拉进来", '解释“把Tonny拉进来”这句话', '`invite Tonny`']) assert.deepEqual(invitedParticipants(prompt, catalog), []);
  const renamed = participantCatalog([{ ...DEFAULT_PARTICIPANTS[1], name: "规划师" }]);
  assert.equal(invitedParticipants("把规划师拉进来", renamed)[0]?.id, "planner");
  assert.deepEqual(invitedParticipants("把Tonny拉进来", renamed), []);
  assert.throws(() => invitedParticipants("请小审来讨论", participantCatalog([critic, { ...critic, id: "bot_22222222-2222-2222-2222-222222222222" }])), /多个 Bot/);
});

test("custom members keep their own identities and only validated engine presets are accepted", async () => {
  const catalog = participantCatalog([critic]);
  assert.equal(selectedParticipants(["assistant", critic.id], catalog).length, 2);
  assert.throws(() => selectedParticipants(["unknown"], catalog), /unavailable/);
  assert.throws(() => selectedParticipants([critic.id, critic.id], catalog), /different/);
  assert.throws(() => participantCatalog([{ ...critic, presetId: "root" }]), /identity/);
  assert.throws(() => participantCatalog([{ ...critic, presetId: "builder" }], catalog), /cannot change/);
  assert.deepEqual(namedParticipants("@小审 评审", catalog, true), [critic.id]);
  assert.equal(untag(`${critic.id}~call-1`).member, critic.id);
  const group = { members: ["assistant", critic.id], participants: catalog, hostId: "assistant", lines: [] };
  assert.deepEqual((await routeParticipantMessage("@小审 看看", group)).plan.members, [critic.id]);
  assert.deepEqual((await routeParticipantMessage("看看", group, async () => '{"mode":"single","members":["missing"]}')).plan.members, ["assistant"]);
  const names = Object.fromEntries(catalog.map(bot => [bot.id, bot.name]));
  const roles = Object.fromEntries(catalog.map(bot => [bot.id, "助手"]));
  const plan = { mode: "discussion" as const, members: [critic.id, "assistant"], source: "rule" as const, rounds: 1 };
  const guest = memberPrompt("assistant", plan.members, plan, [], "看看问题", [], 1, names, roles, critic.id);
  assert.doesNotMatch(guest, /你是群里的协调者/);
  assert.match(guest, /按用户或 小审 已经给出的分工/);
  assert.match(memberPrompt(critic.id, plan.members, plan, [], "看看问题", [], 1, names, roles, critic.id), /你是群里的协调者/);
});

test("renaming preserves mentions, companions, silence rules and every collaboration mode", async () => {
  const participants = participantCatalog([{ id: "planner", name: "tony", presetId: "planner" }]);
  const group = { members: ["assistant", "planner", "builder"], participants, hostId: "assistant", lines: [] };
  for (const prompt of ["@tony 看看", "tony，你看看", "tony好像没有说话", "该 tony 了"]) {
    assert.deepEqual((await routeParticipantMessage(prompt, group)).plan.members, ["planner"]);
  }
  assert.deepEqual((await routeParticipantMessage("@Raer 你和tony看看", group)).plan.members, ["assistant", "planner"]);
  assert.deepEqual((await routeParticipantMessage("@Tonny 看看", group)).plan.members, ["assistant"]);
  for (const mode of ["single", "parallel", "sequential", "round_robin", "discussion"]) {
    const members = mode === "single" ? ["planner"] : ["planner", "builder"];
    const result = await routeParticipantMessage("先分析再动手，两轮", group, async (system, user) => {
      assert.match(system, /稳定成员ID/);
      assert.doesNotMatch(system + user, /Tonny/);
      assert.match(user, /"name":"tony"/);
      return JSON.stringify({ mode, members });
    });
    assert.equal(result.plan.mode, mode);
    assert.deepEqual(result.plan.members, members);
    assert.equal(result.plan.source, "router");
  }
  const legacy = { members: ["assistant", "planner", "builder"], lines: [] };
  assert.deepEqual((await routeParticipantMessage("@Tonny 看看", legacy)).plan.members, ["planner"]);
});

test("custom Bots sharing an engine route by ID, with escaped names, continuation and safe ambiguity", async () => {
  const other = { ...critic, id: "bot_22222222-2222-2222-2222-222222222222", name: "审稿 (A)+" };
  const participants = participantCatalog([critic, other]);
  const group = { members: [critic.id, other.id], hostId: critic.id, participants, lines: [{ author: "user", text: "看一看" }, { author: other.id, text: "结果" }] };
  for (const prompt of ["@审稿 (A)+ 看看", "审稿 (A)+，看看", "审稿 (A)+ 没有回复", "继续说"]) {
    assert.deepEqual((await routeParticipantMessage(prompt, group)).plan.members, [other.id]);
  }
  for (const mode of ["parallel", "sequential", "round_robin", "discussion"]) {
    const result = await routeParticipantMessage("讨论工作", group, async () => JSON.stringify({ mode, members: [other.id, critic.id] }));
    assert.equal(result.plan.mode, mode);
    assert.deepEqual(result.plan.members, [other.id, critic.id]);
  }
  for (const members of [["planner"], [other.name], [other.id, other.id]]) {
    assert.deepEqual((await routeParticipantMessage("看看", group, async () => JSON.stringify({ mode: "sequential", members }))).plan.members, [critic.id]);
  }
  assert.deepEqual(invitedParticipants("把审稿 (A)+拉进来", participants), [other]);
  const prefixed = { ...other, name: `${critic.name} A` };
  assert.deepEqual(namedParticipants(`@${prefixed.name} 看看`, [critic, prefixed], true), [other.id]);
  assert.deepEqual((await routeParticipantMessage(`该${prefixed.name}了`, { ...group, participants: participantCatalog([critic, prefixed]) })).plan.members, [other.id]);
  assert.deepEqual(namedParticipants(`@${prefixed.name} 和 @${critic.name}`, [critic, prefixed], true), [other.id, critic.id]);
  const plan = { mode: "sequential" as const, members: [other.id, critic.id], source: "router" as const };
  const names = { [other.id]: other.name, [critic.id]: critic.name };
  assert.match(memberPrompt(other.id, group.members, plan, [], "先规划", [], 1, names, {}, critic.id, { [other.id]: "planner" }), /你负责规划/);
  const duplicate = { ...group, participants: participantCatalog([critic, { ...other, name: critic.name }]) };
  await assert.rejects(routeParticipantMessage("@小审 看看", duplicate), /多个 Bot/);
});
