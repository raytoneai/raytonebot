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
