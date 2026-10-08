import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addressedMembers, childConversationId, GROUP_MEMBERS, isChildConversationId, isContinuation, isGreeting, mentionedMembers,
  parseRoute, planFromRoute, soleSpeaker, speakingOrder, untag,
} from "./groupChat.ts";

const ID: Record<string, string> = { raer: "assistant", tonny: "planner", bob: "builder" };
const all = [...GROUP_MEMBERS];
const { cases } = JSON.parse(readFileSync(new URL("./testdata/group-routing-cases.json", import.meta.url), "utf8")) as
  { cases: { id: string; message: string; mode: string; members: string[] }[] };

test("@ mentions need a left boundary; an e-mail address is not a mention", () => {
  assert.deepEqual(mentionedMembers("@Tonny @bob 看看", all), ["planner", "builder"]);
  assert.deepEqual(mentionedMembers("发到 rick@bob.com", all), []);
  assert.deepEqual(mentionedMembers("@Bob 改一下", ["assistant", "planner"]), []);
});

test("a name opening the message addresses that member, unless the message speaks to the whole group", () => {
  assert.deepEqual(addressedMembers("Bob, what do you think about e2e tests?", all), ["builder"]);
  assert.deepEqual(addressedMembers("Tonny、Bob，你们俩看看", all), ["planner", "builder"]);
  assert.deepEqual(addressedMembers("Raer: 翻译一下", all), ["assistant"]);
  assert.deepEqual(addressedMembers("Bob，从你开始报数", all), []);
  assert.deepEqual(addressedMembers("Tonny 和 Bob 你俩商量一下", all), []);
  assert.deepEqual(addressedMembers("把报告发给 Bob", all), []);
});

test("on the independently written cases, the rule layer fires exactly on direct addresses", () => {
  for (const c of cases) {
    const hit = mentionedMembers(c.message, all).length ? mentionedMembers(c.message, all) : addressedMembers(c.message, all);
    const gold = c.members.map((m) => ID[m]);
    if (c.mode === "mention") assert.deepEqual(hit, gold, c.id);
    else if (hit.length) {
      assert.ok(c.mode === "single", `${c.id}: rule fired on a ${c.mode} message`);
      assert.deepEqual(hit, gold, c.id);
    }
  }
});

test("speaking order: members named in the message first, then the group order", () => {
  assert.deepEqual(speakingOrder("从 Bob 开始报数", all), ["builder", "assistant", "planner"]);
  assert.deepEqual(speakingOrder("大家报数", all), all);
  for (const c of cases.filter((x) => x.mode === "round_robin" || x.mode === "discussion")) {
    assert.deepEqual(speakingOrder(c.message, all), c.members.map((m) => ID[m]), c.id);
  }
});

test("a name mentioned in passing is a reference; a discussion then starts with whoever alone answered last", () => {
  const correction = "不是还有Raer和Bob么";
  assert.deepEqual(speakingOrder(correction, all), all, "no order word: the names do not move anyone");
  assert.deepEqual(speakingOrder(correction, all, "planner"), ["planner", "assistant", "builder"]);
  assert.deepEqual(speakingOrder("Bob 先说，不是还有Raer么", all, "planner"), ["builder", "assistant", "planner"], "an order word still wins");
  for (const c of cases.filter((x) => x.mode === "round_robin" || x.mode === "discussion")) {
    // Named with an order word: unchanged by who spoke last. Nobody named: the last sole speaker opens.
    const expected = /Raer|Tonny|Bob/i.test(c.message) ? c.members.map((m) => ID[m]) : ["planner", "assistant", "builder"];
    assert.deepEqual(speakingOrder(c.message, all, "planner"), expected, c.id);
  }
  assert.deepEqual(planFromRoute("discussion", all, '{"route":"discussion"}', correction, "planner").members, ["planner", "assistant", "builder"]);
  assert.deepEqual(planFromRoute("round_robin", all, '{"route":"round_robin"}', "大家报数", "planner").members, all, "games keep the group order");

  assert.equal(soleSpeaker([{ author: "user", text: "看看" }, { author: "planner", text: "只有一个 Agent" }]), "planner");
  assert.equal(soleSpeaker([{ author: "user", text: "讨论" }, { author: "assistant", text: "a" }, { author: "builder", text: "b" }]), undefined);
  assert.equal(soleSpeaker([{ author: "planner", text: "a" }, { author: "user", text: "新问题" }]), undefined, "nobody has answered the latest message yet");
  assert.equal(soleSpeaker([]), undefined);
});

test("only a bare greeting counts as one", () => {
  for (const t of ["hello", "Hello everyone!", "大家好", "你好呀", "hi~", "在吗"]) assert.ok(isGreeting(t), t);
  for (const t of ["hello，帮我翻译一下这段", "大家好，介绍一下自己", "嗯", "谢谢"]) assert.ok(!isGreeting(t), t);
});

test("routes map to fixed shapes; anything unknown falls back to Raer", () => {
  assert.equal(parseRoute('```json\n{"route":"bob"}\n```'), "bob");
  assert.equal(parseRoute('{"route":"nobody"}'), undefined);
  assert.equal(parseRoute("[正文为空]"), undefined);
  assert.deepEqual(planFromRoute("plan_then_build", all).members, ["planner", "builder"]);
  assert.deepEqual(planFromRoute("build_then_review", all).members, ["builder", "planner"]);
  assert.deepEqual(planFromRoute("round_robin", all, undefined, "Tonny 先来，成语接龙").members, ["planner", "assistant", "builder"]);
  assert.equal(planFromRoute("parallel", all).mode, "parallel");
  const fallback = planFromRoute(undefined, all, "");
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.members, ["assistant"]);
  assert.equal(planFromRoute("bob", ["assistant", "planner"]).source, "fallback");
  assert.equal(planFromRoute("plan_then_build", ["assistant", "planner"]).source, "fallback");
});

test("member ids are tagged by role and routed back to the member's hidden conversation", () => {
  assert.deepEqual(untag("builder~call_1"), { member: "builder", id: "call_1" });
  assert.deepEqual(untag("call_2"), { id: "call_2" });
  assert.deepEqual(untag("someone~call_3"), { id: "someone~call_3" });
  const child = childConversationId("group_x", "planner");
  assert.equal(child, "group_x.m.planner");
  assert.ok(isChildConversationId(child));
  assert.ok(!isChildConversationId("group_x"));
});

test("deleting a group deletes its members' hidden conversations", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createConversationStore } = await import("./conversationStore.ts");
  const { attachGroupChat } = await import("./groupChat.ts");
  const store = createConversationStore(mkdtempSync(join(tmpdir(), "group-")));
  for (const id of ["group_a", "group_a.m.planner", "group_a.m.builder", "solo"]) store.begin(id, "assistant", "hi");
  store.setExtra("group_a", { group: { members: ["planner", "builder"], lines: [] } });
  const controller = { deleteConversation: (id: string) => store.remove(id), listConversations: () => [] } as never;
  const group = attachGroupChat(controller, { store, userInputGate: {} as never, credentials: () => undefined,
    providerDefinition: () => undefined, providerKey: () => undefined });
  group.deleteConversation("group_a");
  assert.deepEqual(["group_a", "group_a.m.planner", "group_a.m.builder", "solo"].map((id) => Boolean(store.get(id))), [false, false, false, true]);
});

test("only phrases that depend on the previous answer count as a continuation; work and new questions go to the router", () => {
  for (const t of ["展开说说", "展开讲讲", "具体一点", "继续说", "还有呢？", "举个例子", "你说错了，群里还有Raer和Bob", "你漏了回滚的情况",
    "你这个结论有问题", "Go on", "elaborate on the second point", "That's wrong"]) assert.ok(isContinuation(t), t);
  for (const t of ["为什么天空是蓝的", "不是所有文件都支持预览吗", "不是还有Raer和Bob么", "继续实现吧", "不对，直接改代码", "展开说说然后直接把代码改了",
    "换个思路实现", "就这么做", "继续说，大家一起讨论", "go on and implement it", "帮我翻译一下这句", "具体一点".repeat(11)]) {
    assert.ok(!isContinuation(t), t);
  }
});
