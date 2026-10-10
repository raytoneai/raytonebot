import { randomUUID } from "node:crypto";

import type { AgentUXEvent } from "@agent-ux/protocol";

import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import type { UserAnswers, UserQuestion } from "../runtime/userInput.ts";
import type { ConversationStore, StoredConversation } from "./conversationStore.ts";
import type { AgentPresetId } from "./harnessCatalog.ts";
import type { PiPromptInput, PiProviderDefinition } from "./piClient.ts";
import type { PiRuntimeController } from "./piHost.ts";
import type { UserInputGate } from "./userInputGate.ts";
import { createConversationRecorder } from "./conversationRecorder.ts";
import { piErrorTurnEvents } from "./piErrorTurn.ts";
import { redactCredentials } from "./imChannels/redactCredentials.ts";

/**
 * Group chat (ADR-032). A group is a conversation with `group` metadata; each member runs in a
 * hidden child conversation (`<group>.m.<role>`) through the ordinary `runPrompt`, so native
 * sessions, approvals and limits stay per member. A router picks who answers:
 * @mentions and names that open the message by rule, otherwise one JSON call to the configured model;
 * "unclear" falls back to Raer. Child events are re-tagged `<role>~<id>` so the view can
 * show an author per message and route approvals back to the right child.
 */
export const GROUP_MEMBERS: AgentPresetId[] = ["assistant", "planner", "builder"];
export const MEMBER_NAMES: Record<AgentPresetId, string> = { assistant: "Raer", planner: "Tonny", builder: "Bob" };
const MEMBER_ROLES: Record<AgentPresetId, string> = { assistant: "助手", planner: "规划", builder: "实施" };
const CHILD = ".m.";
export const childConversationId = (groupId: string, member: AgentPresetId) => `${groupId}${CHILD}${member}`;
export const isChildConversationId = (id: string) => id.includes(CHILD);

export type GroupPlan = {
  mode: "single" | "parallel" | "sequential" | "mention" | "round_robin" | "discussion" | "intro";
  members: AgentPresetId[];
  source: "mention" | "router" | "fallback" | "rule";
  route?: string;
  note?: string;
};
type GroupLine = { author: "user" | AgentPresetId; text: string };
/** `introduced`: members who have introduced themselves; each does so once, when they join (as in Raft). */
export type GroupMeta = { members: AgentPresetId[]; lines: GroupLine[]; introduced?: AgentPresetId[];
  /** Last thing said in the group, for the sidebar's second line (Grok-style). */
  preview?: { author: "user" | AgentPresetId; text: string } };

// ---------- routing ----------
const MENTION = /(?<![A-Za-z0-9._%+-])@(Raer|Tonny|Bob)\b/gi;
const BY_NAME: Record<string, AgentPresetId> = { raer: "assistant", tonny: "planner", bob: "builder" };

export function mentionedMembers(text: string, members: AgentPresetId[]): AgentPresetId[] {
  const found = [...text.matchAll(MENTION)].map((m) => BY_NAME[m[1].toLowerCase()]).filter((m) => members.includes(m));
  return [...new Set(found)];
}

// "Bob, what do you think" / "Tonny、Bob，你们俩看看": names opening the message, then a comma, colon or 你/您.
const VOCATIVE = /^\s*((?:Raer|Tonny|Bob)(?:\s*(?:[、,，&]|和|and)\s*(?:Raer|Tonny|Bob))*)\s*(?:[,，:：]|你|您)/i;
// Words that address the whole group: then the names only set an order (round_robin/discussion), not who answers.
const WHOLE_GROUP = /大家|所有人|每人|每个人|轮流|报数|接龙|讨论|商量|辩|吵|互相|各自|一人一句|everyone|everybody|each of you|in turn|take turns|discuss|debate/i;

/** Members addressed by name at the start of the message, unless it speaks to the whole group. */
export function addressedMembers(text: string, members: AgentPresetId[]): AgentPresetId[] {
  const match = VOCATIVE.exec(text);
  if (!match || WHOLE_GROUP.test(text)) return [];
  const found = [...match[1].matchAll(/Raer|Tonny|Bob/gi)].map((m) => BY_NAME[m[0].toLowerCase()]).filter((m) => members.includes(m));
  return [...new Set(found)];
}

// Option wording "v3" of the routing evaluation (docs/multi-agent-collaboration-research.md).
export const ROUTER_OPTIONS: Record<string, string> = {
  raer: "交给 Raer 一人：日常事务、问答、解释概念、翻译、写作、总结、数据统计、提醒、日程与会议安排、连接账号或 IM 频道（如 Telegram、飞书），"
    + "修改用户给的文档或文字也算；寒暄、致谢、客套也交给 Raer",
  tonny: "交给 Tonny 一人：出方案、拆解任务、列清单、权衡利弊、分析或排查原因、评审；用户只要思路或明确说先不执行、不改",
  bob: "交给 Bob 一人：动手修改项目的代码、配置或仓库文件，实现功能、修复 bug、补测试；顺带跑测试或确认构建通过、"
    + "按已有计划实现其中一步、对上一条方案说“就这么做”，都仍是 Bob 一人",
  parallel: "用户要求多位成员各自独立给出看法、点子或投票，彼此不需要接着前面的人说，不动手修改",
  round_robin: "成员按顺序各说一次，后面的人要接着前面的人说：报数、接龙、成语接龙、轮流自我介绍、每人轮流说一句、一人一句编故事",
  discussion: "用户明确要求成员之间互相回应、来回讨论几轮再形成结论：讨论方案、辩论、商量一下、互相挑刺、一起评估优劣；"
    + "纠正、质疑或追问某位成员说过的话不算",
  plan_then_build: "用户在同一请求里明确要求先出方案或先找原因，然后再动手实现或修复；只说“实现并测试”或已有计划时不算",
  build_then_review: "用户明确要求先动手实现，做完后再评审或检查",
  unclear: "没有明确请求、把决定完全交给别人，或任务横跨调研、规划、实现、上线多个阶段而过于宽泛",
};
const ROUTER_SYSTEM = [
  "你是群聊路由器，只决定这条用户消息由谁、以什么方式回答，不回答消息本身。",
  "用户在追问、纠正、反驳或质疑上一位回答者说的内容时（即使消息里提到了其他成员的名字），选那位成员的单人选项；"
    + "要求动手执行或换成别的事时，仍按下面各选项判断。",
  "可选项：",
  ...Object.entries(ROUTER_OPTIONS).map(([k, v]) => `- ${k}：${v}`),
  '严格只输出一个 JSON 对象，例如 {"route":"bob"}，不要解释。',
].join("\n");

const roster = (members: AgentPresetId[]) => members.map((m) => `${MEMBER_NAMES[m]}（${MEMBER_ROLES[m]}）`).join("、");

export function routerState(lines: GroupLine[], text: string, members: AgentPresetId[] = GROUP_MEMBERS): string {
  const out = [`群成员：${roster(members)}。`];
  const recent = lines.slice(-6);
  if (recent.length) {
    out.push("最近群消息：");
    for (const line of recent) out.push(`- ${line.author === "user" ? "用户" : MEMBER_NAMES[line.author]}：${line.text.slice(0, 300)}`);
  }
  const previous = soleSpeaker(lines);
  if (previous && members.includes(previous)) out.push(`上一条用户消息只由 ${MEMBER_NAMES[previous]} 回答。`);
  out.push(`用户最新消息：${text}`);
  return out.join("\n");
}

// Words that make names in the message set the order ("Tonny 先来", "Raer starts, then Bob"). Without one, a
// name mid-sentence is only a reference ("不是还有Raer和Bob么"), as in nightly OpenBot's mention parsing.
const ORDER_CUE = /先|首先|开始|起头|开头|第一个|第一位|主持|带头|然后|接着|最后|你俩|你们俩|\b(?:starts?|first|then|next|leads?|kicks? off|goes)\b/i;

/**
 * Speaking order: members the message puts first (an order word, or names opening it) in the order
 * named, the rest in group order. Otherwise `continuing`, the member who alone answered the previous
 * turn, speaks first: the message most likely answers them.
 */
export function speakingOrder(text: string, members: AgentPresetId[], continuing?: AgentPresetId): AgentPresetId[] {
  const ordered = ORDER_CUE.test(text) || VOCATIVE.test(text);
  const named = ordered ? members.map((m) => ({ m, at: text.search(new RegExp(MEMBER_NAMES[m], "i")) })).filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at).map((x) => x.m) : [];
  const first = named.length ? named : continuing && members.includes(continuing) ? [continuing] : [];
  return [...first, ...members.filter((m) => !first.includes(m))];
}

// Phrases that only make sense as a reply to what was just said (nightly OpenBot's continuation rule,
// widened to Chinese). Kept narrow on purpose: "为什么…" or "不是…" may start a new question, so the
// router decides those. Anything that asks for work is left to the router too, which knows who builds.
const CONTINUATION = /^\s*(?:继续说|接着说|接着讲|往下说|展开(?:说说|讲讲|一下|说|讲)?|具体(?:点|一点|说说|讲讲)|详细(?:点|一点|说说|讲讲)|再详细|举个例子|然后呢|还有呢|你(?:说|讲)?错了|你漏了|你说的不对|你这个(?:说法|结论|判断)(?:不对|有问题)|换个说法|go on|keep going|elaborate|tell me more|more detail|for example|you(?:'re| are) wrong|that's (?:wrong|not right))/i;
const ASKS_FOR_WORK = /实现|改|修|做|写|部署|上线|跑|执行|动手|开始|implement|fix|build|code|change|deploy|run|write|do it/i;

/** Is this short message a follow-up to the member who just answered alone? Then it goes to them. */
export function isContinuation(text: string): boolean {
  return text.trim().length <= 40 && CONTINUATION.test(text) && !ASKS_FOR_WORK.test(text) && !WHOLE_GROUP.test(text);
}

/** The member who alone answered the latest turn in the group record, if exactly one did. */
export function soleSpeaker(lines: GroupLine[]): AgentPresetId | undefined {
  const lastUser = lines.map((line) => line.author).lastIndexOf("user");
  const authors = new Set(lines.slice(lastUser + 1).map((line) => line.author).filter((author): author is AgentPresetId => author !== "user"));
  return authors.size === 1 ? [...authors][0] : undefined;
}

export function planFromRoute(route: string | undefined, members: AgentPresetId[], raw?: string, text = "", continuing?: AgentPresetId): GroupPlan {
  const why = route === "unclear" ? "模型判为 unclear" : raw === undefined ? "路由请求失败" : `输出无法解析：${raw.slice(0, 80)}`;
  const fallback: GroupPlan = { mode: "single", members: ["assistant"], source: "fallback", route, note: `${why}；原型暂由 Raer 代替 Supervisor` };
  const one = (m: AgentPresetId): GroupPlan => members.includes(m) ? { mode: "single", members: [m], source: "router", route } : fallback;
  switch (route) {
    case "raer": return one("assistant");
    case "tonny": return one("planner");
    case "bob": return one("builder");
    case "parallel": return { mode: "parallel", members: [...members], source: "router", route };
    case "round_robin": return { mode: "round_robin", members: speakingOrder(text, members), source: "router", route };
    case "discussion": return { mode: "discussion", members: speakingOrder(text, members, continuing), source: "router", route };
    case "plan_then_build": return members.includes("planner") && members.includes("builder")
      ? { mode: "sequential", members: ["planner", "builder"], source: "router", route } : fallback;
    case "build_then_review": return members.includes("planner") && members.includes("builder")
      ? { mode: "sequential", members: ["builder", "planner"], source: "router", route } : fallback;
    default: return fallback;
  }
}

export async function completeJson(definition: Pick<PiProviderDefinition, "baseUrl" | "protocol">, apiKey: string | undefined,
  model: string, system: string, user: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const base = definition.baseUrl.trim().replace(/\/+$/, "");
  const signal = AbortSignal.timeout(15_000);
  if (definition.protocol === "openai-compatible") {
    const response = await fetcher(`${base}/chat/completions`, { method: "POST", signal,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, max_tokens: 800, temperature: 0, stream: false, response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
    if (!response.ok) return undefined;
    const body = await response.json() as { choices?: { finish_reason?: string; message?: { content?: unknown; reasoning_content?: unknown } }[] };
    const choice = body.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text === "string" && text.trim()) return text;
    // Diagnose an empty answer (e.g. a reasoning model spending the token budget on thinking).
    const reasoning = choice?.message?.reasoning_content;
    return `[正文为空；finish_reason=${choice?.finish_reason ?? "?"}；推理 ${typeof reasoning === "string" ? reasoning.length : 0} 字]`;
  }
  if (definition.protocol === "anthropic") {
    const response = await fetcher(`${base}/messages`, { method: "POST", signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify({ model, max_tokens: 800, temperature: 0, system, messages: [{ role: "user", content: user }] }) });
    if (!response.ok) return undefined;
    const body = await response.json() as { content?: { type?: string; text?: unknown }[] };
    const text = body.content?.find((block) => block.type === "text")?.text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

export function parseRoute(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const route = (JSON.parse(match?.[0] ?? raw) as { route?: unknown }).route;
    return typeof route === "string" && route in ROUTER_OPTIONS ? route : undefined;
  } catch { return undefined; }
}

/**
 * Who answers a group message, and how: `@` and vocatives first, then a follow-up to the member who
 * alone answered last, then one JSON choice from the model (`complete`; none means Raer). Shared by
 * the group run and the routing evaluation, so both judge with the same code.
 */
export async function routeGroupMessage(prompt: string, group: Pick<GroupMeta, "members" | "lines">,
  complete?: (system: string, user: string) => Promise<string | undefined>): Promise<{ plan: GroupPlan; raw?: string }> {
  const mentioned = mentionedMembers(prompt, group.members);
  if (mentioned.length) return { plan: { mode: "mention", members: mentioned, source: "mention" } };
  const addressed = addressedMembers(prompt, group.members);
  if (addressed.length) return { plan: { mode: "mention", members: addressed, source: "mention", note: "句首称呼" } };
  const continuing = soleSpeaker(group.lines);
  if (continuing && group.members.includes(continuing) && isContinuation(prompt)) {
    return { plan: { mode: "single", members: [continuing], source: "rule", note: "接着上一位" } };
  }
  const raw = complete ? await complete(ROUTER_SYSTEM, routerState(group.lines, prompt, group.members)).catch(() => undefined) : undefined;
  return { plan: planFromRoute(parseRoute(raw), group.members, raw, prompt, continuing), raw };
}

// ---------- member prompt ----------
const INTERACTION = "这是群聊互动，不是任务：按用户给的规则简短回复（通常一两句），不调用工具，不读写文件。";
const DISCUSSION_ROUNDS = 2;

/**
 * Who decides the split when several members share a turn (CopilotKit OpenBot: "Answer only your own
 * part… do not write replies for them"; nightly OpenBot and TelegramAgent: one lead assigns, the rest
 * execute). Raer stays the coordinator: it may state the split when it opens and the user has not;
 * Tonny and Bob follow the user's or Raer's split and never redo it.
 */
export function partRule(member: AgentPresetId, opening: boolean, independent: boolean): string {
  if (independent) return "只说你自己的看法，不要替其他成员回答。";
  if (member === "assistant") {
    return opening
      ? "你是群里的协调者。用户已经分好工，就照做你那一份；用户没说清谁做什么，你可以先用一句话说明分工，再完成你那一份。其他成员会在各自的回合发言，不要替他们写。"
      : "你是群里的协调者。按用户或已经说明的分工完成你那一份，不要重新分工，也不要替其他成员写。";
  }
  return "按用户或 Raer 已经给出的分工，只完成你自己那一份；其他成员会在各自的回合发言，不要替他们写，也不要重新分工或重新出题。觉得分工不合理可以提一句建议，但本轮仍按原分工完成。";
}

export function memberPrompt(member: AgentPresetId, group: AgentPresetId[], plan: GroupPlan, lines: GroupLine[], text: string,
  previous: { member: AgentPresetId; text: string }[], round = 1): string {
  // The roster is the whole group, not just who speaks this turn: a member answering alone must
  // not conclude it is the only one here.
  const out = [`[群聊] 你是群里的 ${MEMBER_NAMES[member]}（${MEMBER_ROLES[member]}）。群成员：${roster(GROUP_MEMBERS.filter((m) => group.includes(m) || m === member))}，以及用户。只完成你这一部分，用中文或用户的语言直接回复。`];
  const recent = lines.slice(-8);
  if (recent.length) {
    out.push("最近群消息：");
    for (const line of recent) out.push(`- ${line.author === "user" ? "用户" : MEMBER_NAMES[line.author]}：${line.text.slice(0, 1500)}`);
  }
  const order = plan.members.map((m) => MEMBER_NAMES[m]).join(" → ");
  const said = previous.map((p) => `- ${MEMBER_NAMES[p.member]}：${p.text}`);
  // Prompts depend on the turn's mode; topology (who, order, rounds) is fixed by code, never by the prompt.
  const opening = round === 1 && previous.length === 0;
  if (plan.mode === "parallel") out.push(INTERACTION, "本轮每位成员各自独立回答，你看不到别人的回答。", partRule(member, opening, true));
  if (plan.mode === "round_robin") out.push(INTERACTION, `本轮按顺序每人说一次：${order}。轮到你了，接着前面的人说。`, partRule(member, opening, false),
    ...(said.length ? ["本轮前面的发言：", ...said] : ["你是第一个。"]));
  if (plan.mode === "discussion") out.push(`这是群里的讨论，第 ${round}/${DISCUSSION_ROUNDS} 轮，顺序：${order}。回应前面的人，给出你的观点，简短具体，不调用工具，不读写文件。`
    + (round === DISCUSSION_ROUNDS ? "这是最后一轮，尽量收敛。" : ""), partRule(member, opening, false),
    ...(said.length ? ["讨论到目前为止：", ...said] : ["你先开场。"]));
  if (plan.mode === "sequential") {
    out.push(`这是一项工作，本轮按顺序进行：${order}。`, partRule(member, opening, false));
    if (member === "planner") out.push("你负责规划：把计划直接写在回复里，系统会把全文交给下一位成员，不必另写计划或交接文件（用户明确要求除外）。"
      + "共享目录为 shared/plans、shared/handoffs、shared/artifacts；需要现状时直接读相关文件。不要扩大用户要求的范围。");
    if (member === "builder") out.push("你负责实施：按用户要求和计划完成，不扩大范围。验证与改动相称，除非计划或用户要求，不额外截图、渲染、打印或写交接文件。");
    for (const p of previous) out.push(`本轮 ${MEMBER_NAMES[p.member]} 的产出（完整）：\n${p.text}`);
  }
  out.push(`用户本条消息：${text}`);
  return out.join("\n\n");
}

const GREETING = /^\s*(hi|hello|hey|hiya|yo|你好|您好|嗨|哈喽|哈啰|大家好|各位好|你们好|早上好|早安|晚上好|下午好|在吗|在不在)(\s*(everyone|all|guys|大家|各位|呀|啊|哦|～|~|!|！|。|\.|,|，))*\s*$/i;
export const isGreeting = (text: string) => GREETING.test(text);

function introPrompt(member: AgentPresetId, members: AgentPresetId[], previous: { member: AgentPresetId; text: string }[], text: string, joined: boolean): string {
  return [
    joined
      ? `[群聊] 你是 ${MEMBER_NAMES[member]}（${MEMBER_ROLES[member]}），刚被加入这个群。用一句话告诉大家你是谁、在群里负责什么。只说这一句，用户这条消息稍后会另行处理。`
      : `[群聊] 你是 ${MEMBER_NAMES[member]}（${MEMBER_ROLES[member]}）。这个群刚建好，用户打了招呼。用一两句话回应，并说明你在群里负责什么；接着前面的人说，不要重复前面说过的。`,
    `群成员：${roster(members)}，以及用户。不调用工具，不读写文件。`,
    ...(previous.length ? ["前面的人说了：", ...previous.map((p) => `- ${MEMBER_NAMES[p.member]}：${p.text}`)] : []),
    ...(joined ? [] : [`用户的消息：${text}`]),
  ].join("\n\n");
}

export const groupTitle = (members: AgentPresetId[]) => ["我", ...members.map((m) => MEMBER_NAMES[m])].join("、");

function pmAnnouncePrompt(plan: GroupPlan, lines: GroupLine[], text: string): string {
  const order = plan.members.map((m) => MEMBER_NAMES[m]).join(" → ");
  const recent = lines.slice(-6).map((l) => `- ${l.author === "user" ? "用户" : MEMBER_NAMES[l.author]}：${l.text.slice(0, 600)}`);
  return [
    "[群聊 · PM] 你是群里的 Raer，这一轮兼任 PM。用户的请求需要多人配合，分工已经定好：" + order + "。",
    "用一到两句话在群里说明谁先做什么、再交给谁、最后你来汇总，最后一句问用户“要开始吗？”，然后停下。不要回答需求本身，不要调用任何工具。",
    ...(recent.length ? ["最近群消息：", ...recent] : []),
    `用户本条消息：${text}`,
  ].join("\n\n");
}

function pmSummaryPrompt(outputs: { member: AgentPresetId; text: string }[], text: string, discussion = false): string {
  return [
    discussion
      ? "[群聊 · 讨论收口] 你是群里的 Raer。讨论已经结束，请用 3–5 行汇总：大家的共识、仍有分歧的点、建议下一步。不要调用工具，不要重复全文。"
      : "[群聊 · PM 收口] 你是群里的 Raer。本轮成员已经做完，请用 3–5 行在群里汇总：完成了什么、产出在哪、还有什么没做或要用户决定。不要调用工具，不要重复成员的全文。",
    `用户本条消息：${text}`,
    ...outputs.map((o) => `${MEMBER_NAMES[o.member]} 的产出：\n${o.text.slice(0, 6000)}`),
  ].join("\n\n");
}

// ---------- event re-tagging ----------
function retag(event: AgentUXEvent, member: AgentPresetId, groupRunId: string, runTag?: string): AgentUXEvent {
  const tag = (value: unknown) => typeof value === "string" && value && !value.startsWith(`${member}~`) ? `${member}~${value}` : value;
  // Engines number messages per run (m1, m2…); a member speaking twice in one turn must not merge.
  const tagMessage = (value: unknown) => typeof value === "string" && value && runTag && !value.startsWith(`${member}~`) ? `${member}~${runTag}:${value}` : tag(value);
  const payload: Record<string, unknown> = { ...(event.payload ?? {}) };
  for (const key of Object.keys(payload)) if (/Id$/.test(key)) payload[key] = tag(payload[key]);
  return { ...event, id: tag(event.id) as string | undefined, runId: groupRunId,
    messageId: tagMessage(event.messageId) as string | undefined, payload } as AgentUXEvent;
}
export const untag = (value: string): { member?: AgentPresetId; id: string } => {
  const at = value.indexOf("~");
  const member = at > 0 ? value.slice(0, at) as AgentPresetId : undefined;
  return member && GROUP_MEMBERS.includes(member) ? { member, id: value.slice(at + 1) } : { id: value };
};

// ---------- controller wrapper ----------
type Deps = {
  store: ConversationStore;
  userInputGate: UserInputGate;
  credentials(providerId?: string): { definition: PiProviderDefinition; apiKey?: string } | undefined;
  providerDefinition(providerId?: string): PiProviderDefinition | undefined;
  providerKey(providerId?: string): string | undefined;
  log?(event: string, fields: Record<string, unknown>): void;
  providerIds?(): string[];
  /** Summarize a topic title with the turn's model service; never overwrites a title already summarized. */
  titleGroup?(id: string, input: PiPromptInput, prompt: string): Promise<void>;
};

export type GroupController = PiRuntimeController & {
  runGroupPrompt(input: PiPromptInput, onEvent: (event: AgentUXEvent) => void): Promise<void>;
};

export function attachGroupChat(controller: PiRuntimeController, deps: Deps): GroupController {
  const active = new Map<string, { abort: AbortController; runId: string; done: Promise<void>;
    watchers: Set<(event: AgentUXEvent) => void>; children: Map<AgentPresetId, string> }>();
  const resets = new Map<string, ReturnType<PiRuntimeController["newSession"]>>();
  const backfilled = new Set<string>();
  const groupOf = (id?: string) => {
    if (!id) return undefined;
    const conversation = deps.store.get(id) as (StoredConversation & { group?: GroupMeta }) | undefined;
    return conversation?.group ? conversation : undefined;
  };

  async function runGroupPrompt(input: PiPromptInput, onEvent: (event: AgentUXEvent) => void) {
    const groupId = input.conversationId!;
    const prompt = redactCredentials(input.prompt.trim());
    if (!groupId || !prompt) throw new Error("A group conversation and prompt are required.");
    for (let reset = resets.get(groupId); reset; reset = resets.get(groupId)) await reset;
    if (active.has(groupId)) throw new Error("This group already has a turn in progress.");
    const groupRunId = input.requestId ?? `group_${randomUUID()}`;
    // The persisted user-message receipt is also the group's request ledger, including old groups.
    if (deps.store.get(groupId)?.events.some((event) => event.runId === groupRunId)) {
      throw new Error("This request id has already been submitted.");
    }
    const existing = groupOf(groupId);
    const abort = new AbortController();
    let settle!: () => void;
    const slot = { abort, runId: groupRunId, done: new Promise<void>((resolve) => { settle = resolve; }),
      watchers: new Set([onEvent]), children: new Map<AgentPresetId, string>() };
    active.set(groupId, slot);
    const meta: GroupMeta = structuredClone(existing?.group ?? { members: [...GROUP_MEMBERS], lines: [] });
    // The client sends the group's members (chosen in "To:", edited in the member panel); keep the group order.
    const requested = (input as PiPromptInput & { members?: unknown }).members;
    if (Array.isArray(requested)) {
      const chosen = GROUP_MEMBERS.filter((m) => requested.includes(m));
      if (chosen.length) meta.members = chosen;
    }
    // Until a topic is summarized, a group is named by its members; a summarized topic is kept.
    const named = () => (deps.store.get(groupId)?.titleSource === "summary" ? {} : { title: groupTitle(meta.members) });
    const reportFailure = (event: string, error: unknown) => {
      try { deps.log?.(event, { conversationId: groupId, runId: groupRunId,
        error: redactCredentials(error instanceof Error ? error.message : String(error)) }); }
      catch { /* Diagnostics must not change the accepted turn's outcome. */ }
    };
    const broadcast = (event: AgentUXEvent) => {
      for (const watcher of slot.watchers) {
        try { watcher(event); }
        catch (error) { slot.watchers.delete(watcher); reportFailure("group.subscriber_failed", error); }
      }
    };
    const recorder = createConversationRecorder({ store: deps.store, conversationId: groupId, runId: groupRunId,
      broadcast,
      stop: () => abort.abort(),
    });
    const emit = (events: AgentUXEvent[]) => {
      for (const event of events) {
        if (!recorder.ended) recorder.record({ ...event, seq: (deps.store.get(groupId)?.events.length ?? 0) + 1 });
      }
    };
    // Routing is control-plane detail: a debug event (shown with ?devtools=1) and a log line, never a speaker.
    const debug = (events: AgentUXEvent[]) => emit(events.map((event) => ({ ...event, visibility: "debug" }) as AgentUXEvent));
    const asRaer = (events: AgentUXEvent[]) => emit(events.map((event) => retag(event, "assistant", groupRunId)));
    const adapter = createPiEventAdapter({ runId: groupRunId });
    let status: "success" | "cancelled" | "error" = "success";
    let opened = false;
    let memberFailure: unknown;
    let turnFailure: unknown;
    let unsavedFailure: AgentUXEvent[] | undefined;
    const outputs: { member: AgentPresetId; text: string }[] = [];
    let joinLines: GroupLine[] = [];

    let permissionMode = input.permissionMode;
    const runMember = async (member: AgentPresetId, memberPromptText: string, record = true) => {
      try {
        abort.signal.throwIfAborted();
        const childId = childConversationId(groupId, member);
        if (member === "assistant") {
          await controller.configure({ conversationId: childId, provider: input.provider, model: input.model,
            thinkingLevel: input.thinkingLevel, providerDefinition: deps.providerDefinition(input.provider), apiKey: deps.providerKey(input.provider) });
        }
        abort.signal.throwIfAborted();
        const childRunId = `${groupRunId}.${member}.${randomUUID().slice(0, 6)}`;
        slot.children.set(member, childRunId);
        // The member's face shows from the moment it starts working (context, thinking), not from its first word.
        // An unknown event type: the renderer ignores it; the shell derives "who is thinking" from it.
        emit([{ type: "group.member.started", id: `${childRunId}_typing`, runId: groupRunId, visibility: "debug", payload: { member } } as AgentUXEvent]);
        let text = "";
        let failure: string | undefined;
        let cancelled = false;
        await controller.runPrompt({ ...input, permissionMode, conversationId: childId, requestId: childRunId, agentPreset: member, prompt: memberPromptText }, (event) => {
          if (event.type === "run.finished") {
            if (event.payload.status === "error") failure ??= "Member run failed.";
            if (event.payload.status === "cancelled") cancelled = true;
            return;
          }
          if (event.type === "run.started" || event.type === "capability.attached") return;
          if (event.messageId === `${childRunId}_user`) return;
          if (event.type === "run.error") {
            failure = String((event.payload as { message?: unknown }).message ?? "").trim() || "Member run failed.";
            return;
          }
          if (event.type === "text.delta" && typeof (event.payload as { delta?: unknown }).delta === "string") text += (event.payload as { delta: string }).delta;
          emit([retag(event, member, groupRunId, childRunId)]);
        }, { signal: abort.signal, waitForCapacity: true });
        if (failure !== undefined) throw new Error(failure);
        if (cancelled) abort.abort();
        abort.signal.throwIfAborted();
        if (record) outputs.push({ member, text });
        return text;
      } catch (error) {
        if (!abort.signal.aborted) {
          const message = (error instanceof Error ? error.message : String(error)).trim() || "Member run failed.";
          memberFailure = new Error(`${MEMBER_NAMES[member]}: ${message}`, { cause: error });
          status = "error";
          abort.abort();
        }
        throw error;
      } finally { slot.children.delete(member); }
    };

    try {
      deps.store.begin(groupId, "assistant", prompt);
      deps.store.setExtra(groupId, { group: meta, ...named() });
      opened = true;
      emit(adapter.startUserMessage(prompt));

      // 1. route (rules, then one JSON call)
      const started = Date.now();
      const credentials = deps.credentials(input.provider);
      const routed = await routeGroupMessage(prompt, meta, credentials ? (system, user) => completeJson(credentials.definition,
        credentials.apiKey, input.model ?? credentials.definition.models[0], system, user) : undefined);
      let plan = routed.plan;
      const routerRaw = routed.raw;
      const mentioned = plan.source === "mention" ? plan.members : [];
      const order = plan.members.map((m) => MEMBER_NAMES[m]);
      const routeText = `${plan.mode} ${order.join(" → ")} · ${plan.source}${plan.route ? `(${plan.route})` : ""}${plan.note ? ` · ${plan.note}` : ""} · ${Date.now() - started} ms${routerRaw !== undefined ? ` · raw=${routerRaw.slice(0, 200)}` : ""}`;
      deps.log?.("group.route", { conversationId: groupId, mode: plan.mode, members: plan.members, source: plan.source, route: plan.route, ms: Date.now() - started });
      const routeId = `${groupRunId}_route`;
      debug(adapter.apply({ type: "tool_execution_start", toolCallId: routeId, toolName: "group_route", args: { route: routeText } }));
      debug(adapter.apply({ type: "tool_execution_end", toolCallId: routeId, toolName: "group_route", result: { content: [{ type: "text", text: routeText }] } }));

      // 1b. Introductions follow membership, not greetings: once per member, when they join.
      // Groups from before this field existed have already met; only genuinely new members introduce themselves.
      const introduced = meta.introduced ?? (meta.lines.length ? [...meta.members] : []);
      const newcomers = meta.members.filter((m) => !introduced.includes(m));
      const firstTurn = meta.lines.length === 0;
      if (newcomers.length && firstTurn && isGreeting(prompt) && !mentioned.length) {
        plan = { mode: "intro", members: [...meta.members], source: "rule", note: "新群的第一句问候" };
        deps.log?.("group.intro", { conversationId: groupId, members: plan.members });
      } else if (newcomers.length && !firstTurn) {
        const said: { member: AgentPresetId; text: string }[] = [];
        for (const member of newcomers) {
          if (abort.signal.aborted) break;
          // Not one of this turn's speakers: the introduction goes to the group record only.
          said.push({ member, text: await runMember(member, introPrompt(member, meta.members, said, prompt, true), false) });
        }
        joinLines = said.map((p) => ({ author: p.member, text: p.text }));
        deps.log?.("group.joined", { conversationId: groupId, members: newcomers });
      }
      meta.introduced = [...meta.members];

      if (plan.mode === "intro") {
        for (const member of plan.members) {
          if (abort.signal.aborted) break;
          await runMember(member, introPrompt(member, meta.members, [...outputs], prompt, false));
        }
      } else if (plan.mode !== "sequential") {
        // 2a. one hop: the chosen members just speak.
        if (plan.mode === "parallel") {
          // Keep the group occupied until every child has stopped; no events may follow its terminal.
          const results = await Promise.allSettled(plan.members.map((m) => runMember(m, memberPrompt(m, meta.members, plan, meta.lines, prompt, []))));
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw memberFailure ?? failed.reason;
        }
        else if (plan.mode === "discussion") {
          for (let round = 1; round <= DISCUSSION_ROUNDS && !abort.signal.aborted; round++) {
            for (const member of plan.members) {
              if (abort.signal.aborted) break;
              await runMember(member, memberPrompt(member, meta.members, plan, meta.lines, prompt, [...outputs], round));
            }
          }
          if (!abort.signal.aborted) await runMember("assistant", pmSummaryPrompt(outputs, prompt, true));
        } else for (const member of plan.members) {
          if (abort.signal.aborted) break;
          await runMember(member, memberPrompt(member, meta.members, plan, meta.lines, prompt, [...outputs]));
        }
      } else {
        // 2b. a multi-member task: Raer, as PM, states the split in the group and asks to start.
        await runMember("assistant", pmAnnouncePrompt(plan, meta.lines, prompt), false);
        const confirmId = `${groupRunId}_confirm`;
        const questions: UserQuestion[] = [{ id: "plan", header: "分工", multiSelect: false, allowOther: false,
          question: `${order.join(" → ")}`,
          options: [
            { label: "开始", description: "本轮工作区内的读写与命令不再逐个询问" },
            { label: "只交给 Bob", description: "跳过规划/评审" },
            { label: "只交给 Tonny", description: "只要方案或评审，不动手" },
            { label: "先不做", description: "这条消息不执行" },
          ] }];
        let requestId = "";
        const answers: UserAnswers = await deps.userInputGate.wait(groupId, confirmId, questions, abort.signal, (request) => {
          requestId = request.requestId;
          // Only the card: Raer's own message already asked "start?", so drop the adapter's echo of the question.
          asRaer(adapter.apply({ type: "user_input_required", ...request }).filter((event) => !event.type.startsWith("text.")));
        }, (value) => asRaer(adapter.apply({ type: "user_input_resolved", requestId, toolCallId: confirmId, questions, answers: value })));
        const choice = answers?.plan?.[0];
        deps.log?.("group.confirm", { conversationId: groupId, choice: choice ?? null });
        const steps: AgentPresetId[] = choice === "开始" ? plan.members : choice === "只交给 Bob" ? ["builder"] : choice === "只交给 Tonny" ? ["planner"] : [];
        const executed: GroupPlan = steps.length > 1 ? plan : { ...plan, mode: "single", members: steps };
        // Choosing a split authorizes this turn's workspace work; protected and outward actions still ask.
        if (steps.length && permissionMode === "request") permissionMode = "auto";
        for (const member of steps) {
          if (abort.signal.aborted) break;
          await runMember(member, memberPrompt(member, meta.members, executed, meta.lines, prompt, [...outputs]));
        }
        // 3. Raer closes the loop with a short summary of what the members produced.
        if (steps.length > 1 && !abort.signal.aborted) await runMember("assistant", pmSummaryPrompt(outputs, prompt));
      }
      if (abort.signal.aborted) status = "cancelled";
    } catch (error) {
      if (!opened) throw error;
      status = memberFailure || !abort.signal.aborted ? "error" : "cancelled";
      turnFailure = memberFailure ?? error;
    } finally {
      try {
        if (opened) {
          if (!recorder.failed) {
            meta.lines = [...meta.lines, ...joinLines, { author: "user" as const, text: prompt }, ...outputs.map((o) => ({ author: o.member, text: o.text.slice(0, 4000) }))].slice(-20);
            const last = [...outputs].reverse().find((o) => o.text.trim());
            meta.preview = last ? { author: last.member, text: last.text.replace(/\s+/g, " ").trim().slice(0, 80) } : { author: "user", text: prompt.slice(0, 80) };
            try { deps.store.setExtra(groupId, { group: meta, ...named() }); }
            catch (error) { status = "error"; turnFailure = error; }
          }
          if (status === "error") emit(adapter.apply({ type: "extension_error",
            message: turnFailure instanceof Error ? turnFailure.message : String(turnFailure ?? "Group run failed.") }));
          emit(adapter.finish(status));
        }
      } catch (error) {
        status = "error";
        reportFailure("group.finalize_failed", error);
        // Bypass a broken adapter during finalization. A saved terminal stays authoritative;
        // disk failures are reported by finish(). Neither means this prompt was rejected.
        if (!recorder.ended) {
          const failures = piErrorTurnEvents({ runId: groupRunId, code: "group_runtime_error",
            message: error instanceof Error ? error.message : String(error) });
          try { emit(failures); }
          catch (failure) {
            reportFailure("group.finalize_failed", failure);
            if (!recorder.ended) unsavedFailure = failures;
          }
        }
      } finally {
        try {
          if (opened) {
            if (!recorder.finish()) status = "error";
            else for (const event of unsavedFailure ?? []) broadcast(event);
          }
        }
        finally { active.delete(groupId); settle(); }
      }
    }
    // The topic comes from the first real request, not from "hello".
    if (status === "success" && !isGreeting(prompt) && deps.titleGroup) {
      void Promise.resolve().then(() => {
        if (deps.store.get(groupId)?.titleSource !== "summary") return deps.titleGroup!(groupId, input, prompt);
      }).catch((error) => reportFailure("group.title_failed", error));
    }
  }

  const childOf = (groupId: string | undefined, tagged: string) => {
    const { member, id } = untag(tagged);
    return groupId && member && groupOf(groupId) ? { childId: childConversationId(groupId, member), id } : undefined;
  };

  return {
    ...controller,
    runGroupPrompt,
    listConversations: (query) => controller.listConversations(query).filter((entry) => !isChildConversationId(entry.id))
      .map((entry) => {
        const group = (entry as { group?: GroupMeta }).group;
        if (!group) return { ...entry, running: entry.running || active.has(entry.id) };
        // Groups saved before titles/previews existed: derive the preview, and title them once from their first real request.
        const lastLine = group.lines.at(-1);
        const preview = group.preview ?? (lastLine ? { author: lastLine.author, text: lastLine.text.replace(/\s+/g, " ").trim().slice(0, 80) } : undefined);
        const firstRequest = group.lines.find((line) => line.author === "user" && !isGreeting(line.text));
        const provider = deps.providerIds?.()[0];
        if (!entry.titleSource && firstRequest && !backfilled.has(entry.id) && !active.has(entry.id) && deps.credentials(provider)?.apiKey) {
          backfilled.add(entry.id);
          void deps.titleGroup?.(entry.id, { prompt: firstRequest.text, provider }, firstRequest.text).catch(() => undefined);
        }
        return { ...entry, group: { ...group, preview }, running: entry.running || active.has(entry.id),
          activeRunId: active.get(entry.id)?.runId ?? entry.activeRunId };
      }),
    followRun(conversationId, after, onEvent) {
      const slot = active.get(conversationId);
      if (!slot) return controller.followRun(conversationId, after, onEvent);
      for (const event of (deps.store.get(conversationId)?.events ?? []).slice(Math.max(0, after))) onEvent(event);
      slot.watchers.add(onEvent);
      return { done: slot.done, stop: () => slot.watchers.delete(onEvent) };
    },
    async abort(conversationId, runId) {
      if (!conversationId) {
        const hadGroups = active.size > 0;
        for (const turn of active.values()) turn.abort.abort();
        return await controller.abort() || hadGroups;
      }
      const turn = conversationId ? active.get(conversationId) : undefined;
      if (!turn) return controller.abort(conversationId, runId);
      if (runId && turn.runId !== runId) return false;
      turn.abort.abort();
      await Promise.all([...turn.children].map(([m, id]) => controller.abort(childConversationId(conversationId, m), id).catch(() => false)));
      return true;
    },
    resolveApproval(toolCallId, decision, conversationId, runId) {
      const child = childOf(conversationId, toolCallId);
      if (!child) return controller.resolveApproval(toolCallId, decision, conversationId, runId);
      const turn = active.get(conversationId!);
      const childRunId = turn?.children.get(untag(toolCallId).member!);
      if (!turn || !childRunId || runId && turn.runId !== runId) return false;
      return controller.resolveApproval(child.id, decision, child.childId, childRunId);
    },
    resolveUserInput(conversationId, requestId, answers) {
      // The PM confirmation is asked by the group itself but shown under Raer, so its id is tagged too.
      if (conversationId && controller.resolveUserInput(conversationId, untag(requestId).id, answers)) return true;
      const child = childOf(conversationId, requestId);
      return child ? controller.resolveUserInput(child.childId, child.id, answers) : false;
    },
    deleteConversation(id) {
      if (active.has(id)) throw new Error("A run is already active in this conversation. Stop it before deleting the conversation.");
      const group = groupOf(id);
      controller.deleteConversation(id);
      // The members' hidden conversations belong to the group and go with it.
      if (group) for (const member of GROUP_MEMBERS) {
        if (deps.store.get(childConversationId(id, member))) controller.deleteConversation(childConversationId(id, member));
      }
    },
    async newSession(conversationId) {
      if (conversationId && active.has(conversationId)) {
        throw new Error("Stop this conversation's run before starting a new session.");
      }
      if (!conversationId) return controller.newSession(conversationId);
      const pending = resets.get(conversationId);
      if (pending) return pending;
      const reset = controller.newSession(conversationId);
      resets.set(conversationId, reset);
      try { return await reset; }
      finally { if (resets.get(conversationId) === reset) resets.delete(conversationId); }
    },
    getConversation(id) {
      const conversation = controller.getConversation(id);
      const turn = active.get(id);
      return conversation && turn ? { ...conversation, activeRunId: turn.runId, incomplete: false } : conversation;
    },
    dispose() {
      for (const turn of active.values()) turn.abort.abort();
      controller.dispose();
    },
  };
}
