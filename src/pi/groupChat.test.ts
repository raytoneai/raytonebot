import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addressedMembers, childConversationId, companions, GROUP_MEMBERS, isChildConversationId, isContinuation, isGreeting, memberPrompt, mentionedMembers,
  completeJson, MAX_ROUNDS, parseRoute, planFromRoute, requestedRounds, routeGroupMessage, routerThinking, silentMember, soleSpeaker, speakingOrder, untag,
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

test("in a shared turn Raer coordinates the split and the others keep to theirs", () => {
  const plan = { mode: "round_robin" as const, members: ["assistant", "planner", "builder"] as ("assistant" | "planner" | "builder")[], source: "router" as const };
  const ask = "你们搞一个对对联游戏，一个上联一个下联一个横批";
  const raer = memberPrompt("assistant", all, plan, [], ask, []);
  assert.match(raer, /You coordinate the group/);
  assert.match(raer, /If assignments are unclear, you may state the split in one sentence/, "opening, Raer may state the split");
  const raerLater = memberPrompt("assistant", all, { ...plan, members: ["planner", "assistant", "builder"] }, [], ask, [{ member: "planner", text: "下联" }]);
  assert.match(raerLater, /(?:Do not reassign work|Do not write for them, reassign work)/);
  assert.doesNotMatch(raerLater, /state the split in one sentence/, "not opening: Raer follows the split already given");
  const bob = memberPrompt("builder", all, plan, [], ask, [{ member: "assistant", text: "上联：…Tonny 接下联，Bob 补横批" }, { member: "planner", text: "下联：…" }]);
  assert.match(bob, /Follow the assignments from the user or Raer and complete only your own part/);
  assert.match(bob, /Do not write for them, reassign work or invent a new task/);
  assert.doesNotMatch(bob, /You coordinate the group/);
  for (const mode of ["discussion", "sequential"] as const) {
    assert.match(memberPrompt("planner", all, { ...plan, mode }, [], ask, [{ member: "assistant", text: "a" }]), /(?:Do not reassign work|Do not write for them, reassign work)/, mode);
  }
  const parallel = memberPrompt("builder", all, { ...plan, mode: "parallel" }, [], ask, []);
  assert.match(parallel, /Give only your own view; do not answer for other members/);
  assert.doesNotMatch(parallel, /state the split/, "parallel answers are independent: nobody assigns");
  assert.doesNotMatch(memberPrompt("assistant", all, { ...plan, mode: "single", members: ["assistant"] }, [], "翻译一下", []), /分工/,
    "a member answering alone gets no split rule");
});

test("the router turns DeepSeek's thinking off and sends nothing extra to other services", async () => {
  assert.deepEqual(routerThinking("https://api.deepseek.com/v1"), { thinking: { type: "disabled" } });
  assert.deepEqual(routerThinking("https://api.deepseek.com/anthropic"), { thinking: { type: "disabled" } });
  for (const url of ["https://api.openai.com/v1", "https://notdeepseek.com.example.org/v1", "http://127.0.0.1:5299/v1", "not a url"]) {
    assert.deepEqual(routerThinking(url), {}, url);
  }
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"route":"raer"}' } }], content: [{ type: "text", text: '{"route":"raer"}' }] }));
  }) as unknown as typeof fetch;
  await completeJson({ baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" }, "k", "deepseek-flash", "s", "u", fetcher);
  await completeJson({ baseUrl: "https://api.deepseek.com/anthropic", protocol: "anthropic" }, "k", "deepseek-flash", "s", "u", fetcher);
  await completeJson({ baseUrl: "https://api.openai.com/v1", protocol: "openai-compatible" }, "k", "gpt", "s", "u", fetcher);
  assert.deepEqual(bodies.map((body) => body.thinking), [{ type: "disabled" }, { type: "disabled" }, undefined]);
});

test("a round count in the message sets how many rounds a game or discussion runs", () => {
  for (const [text, rounds] of [["再来两轮试试", 2], ["来3轮成语接龙", 3], ["接龙三圈", 3], ["讨论 2 回合", 2], ["play two rounds", 2],
    ["再来一轮", 1], ["来二十轮", MAX_ROUNDS], ["99 rounds of counting", MAX_ROUNDS]] as const) assert.equal(requestedRounds(text), rounds, text);
  for (const text of ["第二轮收尾", "大家轮流说", "再来一次", "成语接龙", "0轮"]) assert.equal(requestedRounds(text), undefined, text);
  assert.equal(planFromRoute("round_robin", all, undefined, "再来两轮试试").rounds, 2);
  assert.equal(planFromRoute("discussion", all, undefined, "讨论三轮").rounds, 3);
  assert.equal("rounds" in planFromRoute("round_robin", all, undefined, "成语接龙"), false, "no count: one round, as before");

  const plan = { mode: "round_robin" as const, members: all, source: "router" as const, rounds: 2 };
  const second = memberPrompt("planner", all, plan, [], "再来两轮试试", [{ member: "assistant", text: "a" }, { member: "planner", text: "b" }, { member: "builder", text: "c" }], 2);
  assert.match(second, /Total rounds: 2; current round: 2\/2/);
  assert.match(second, /do not announce the start or end of a new round/, "the code, not the member, counts rounds");
  assert.match(second, /Earlier rounds:/);
  assert.match(memberPrompt("planner", all, { ...plan, rounds: undefined }, [], "成语接龙", []), /Each member speaks once in order this round/);
  assert.match(memberPrompt("builder", all, { ...plan, mode: "discussion", rounds: 3 }, [], "讨论三轮", [], 3), /round 3\/3.*This is the final round/);
});

test("an @-mention takes its companions along, and a silent member gets the turn when the user points it out", async () => {
  assert.deepEqual(companions("@Raer 你和tonny玩一次", ["assistant"], all), ["planner"]);
  assert.deepEqual(companions("@Bob please work with Tonny", ["builder"], all), ["planner"]);
  for (const t of ["@Raer 看看Tonny写的方案", "@Raer 你和我玩", "@Tonny 和@Bob"]) assert.deepEqual(companions(t, ["assistant"], all), [], t);
  const route = (text: string, answer?: string) => routeGroupMessage(text, { members: all, lines: [] }, answer ? async () => answer : undefined);
  assert.deepEqual((await route("@Raer 你和tonny玩一次", '{"route":"round_robin"}')).plan,
    { mode: "round_robin", members: ["assistant", "planner"], source: "mention", route: "round_robin", note: "@ 与同伴" });
  assert.deepEqual((await route("@Raer 你和Tonny的方案哪个好", '{"route":"raer"}')).plan.members, ["assistant"], "the other name was a reference");
  assert.deepEqual((await route("@Raer 你和tonny玩一次")).plan.members, ["assistant", "planner"], "no router: both answer in turn");
  assert.equal((await route("@Bob 看看")).raw, undefined, "a single mention never calls the router");

  for (const [t, m] of [["tonny好像没有说话", "planner"], ["该Bob了", "builder"], ["轮到 Tonny", "planner"], ["Bob didn't answer", "builder"]] as const) {
    assert.deepEqual((await route(t, '{"route":"raer"}')).plan, { mode: "single", members: [m], source: "rule", note: "点名未发言的成员" }, t);
  }
  for (const t of ["Tonny 没问题", "Bob 不错"]) assert.equal(silentMember(t, all), undefined, t);

  const pair = { mode: "mention" as const, members: ["assistant", "planner"] as ("assistant" | "planner")[], source: "mention" as const };
  const tonny = memberPrompt("planner", all, pair, [], "@Raer 你和tonny玩一次", [{ member: "assistant", text: "大器晚成。Tonny，接「成」字。" }]);
  assert.match(tonny, /Members answer this message in order: Raer → Tonny[\s\S]*Earlier member replies to this message:\s*- Raer：大器晚成/, "a later member sees what this turn already said");
  assert.match(memberPrompt("assistant", all, { ...pair, members: ["assistant"] }, [], "@Raer 讲个笑话", []), /Only you answer this message[\s\S]*do not call on them to speak/);
});

test("Japanese greetings use the introduction path while substantive requests still route normally", () => {
  for (const greeting of ["こんにちは", "こんばんは！", "おはようございます", "はじめまして"]) assert.equal(isGreeting(greeting), true);
  assert.equal(isGreeting("こんにちは、このコードを確認してください"), false);
  const request = "日本語で計画を説明してください";
  const prompt = memberPrompt("planner", all, { mode: "single", members: ["planner"], source: "rule" }, [], request, []);
  assert.ok(prompt.includes(`Current user request:\n${request}`));
  assert.match(prompt, /English host context does not determine the reply language/);
});
