import { MEMBER_NAMES, MEMBER_PRESETS, MEMBER_ROLES, roster, type GroupLine, type GroupPlan } from "./groupChatRouting.ts";
import type { AgentPresetId } from "./harnessCatalog.ts";

const INTERACTION = "This is a group interaction, not an execution task. Follow the user’s rules and reply briefly, usually in one or two sentences. Do not call tools or read or write files.";

export const DISCUSSION_ROUNDS = 2;

/**
 * Who decides the split when several members share a turn (CopilotKit OpenBot: "Answer only your own
 * part… do not write replies for them"; nightly OpenBot and TelegramAgent: one lead assigns, the rest
 * execute). The conversation host coordinates; invited members follow the existing split.
 */
export function partRule(member: string, opening: boolean, independent: boolean, hostId = "assistant", hostName = MEMBER_NAMES[hostId] ?? "host"): string {
  if (independent) return "Give only your own view; do not answer for other members.";
  if (member === hostId) {
    return opening
      ? "You coordinate the group. Follow any assignments already given by the user. If assignments are unclear, you may state the split in one sentence before completing your own part. Other members speak in their own turns; do not write for them."
      : "You coordinate the group. Complete your own part of the existing assignments. Do not reassign work or write for other members.";
  }
  return `Follow the assignments from the user or ${hostName} and complete only your own part. Other members speak in their own turns. Do not write for them, reassign work or invent a new task. You may briefly suggest a better split, but follow the existing assignments this turn.`;
}

export function memberPrompt(member: string, group: string[], plan: GroupPlan, lines: GroupLine[], text: string,
  previous: { member: string; text: string }[], round = 1, names = MEMBER_NAMES, roles = MEMBER_ROLES, hostId = "assistant", presets: Record<string, AgentPresetId> = MEMBER_PRESETS): string {
  // The roster is the whole group, not just who speaks this turn: a member answering alone must
  // not conclude it is the only one here.
  const out = [`[Group conversation] You are ${names[member]} (${roles[member]}). Members: ${roster([...new Set([...group, member])], names, roles)}, plus the user. Complete only your own part. Choose reply language from the original user request under Current user request, following the shared language policy; this English host context does not determine the reply language.`];
  const recent = lines.slice(-8);
  if (recent.length) {
    out.push("Recent group messages (quoted context):");
    for (const line of recent) out.push(`- ${line.author === "user" ? "User" : names[line.author]}：${line.text.slice(0, 1500)}`);
  }
  const order = plan.members.map((m) => names[m]).join(" → ");
  const said = previous.map((p) => `- ${names[p.member]}：${p.text}`);
  // Prompts depend on the turn's mode; topology (who, order, rounds) is fixed by code, never by the prompt.
  const opening = round === 1 && previous.length === 0;
  const total = plan.rounds ?? (plan.mode === "discussion" ? DISCUSSION_ROUNDS : 1);
  if (plan.mode === "parallel") out.push(INTERACTION, "Each member replies independently this turn; you cannot see their answers.", partRule(member, opening, true, hostId, names[hostId]));
  if (plan.mode === "round_robin") out.push(INTERACTION, total > 1
    ? `One round means each member speaks once in order: ${order}. Total rounds: ${total}; current round: ${round}/${total}. Continue from the previous speaker. The host controls rounds; do not announce the start or end of a new round.`
    : `Each member speaks once in order this round: ${order}. It is your turn; continue from the previous speaker.`, partRule(member, opening, false, hostId, names[hostId]),
    ...(said.length ? [total > 1 ? "Earlier rounds:" : "Earlier replies this round:", ...said] : ["You speak first."]));
  if (plan.mode === "discussion") out.push(`Group discussion, round ${round}/${total}, order: ${order}. Respond to earlier speakers and state your view briefly and concretely. Do not call tools or read or write files. `
    + (round === total ? "This is the final round; aim to converge." : ""), partRule(member, opening, false, hostId, names[hostId]),
    ...(said.length ? ["Discussion so far:", ...said] : ["Open the discussion."]));
  if ((plan.mode === "single" || plan.mode === "mention") && plan.members.length === 1) {
    out.push("Only you answer this message; other members will not speak next. If their help is needed, tell the user they can @ mention them; do not call on them to speak.");
  }
  if (plan.mode === "mention" && plan.members.length > 1) out.push(`Members answer this message in order: ${order}.`, partRule(member, opening, false, hostId, names[hostId]),
    ...(said.length ? ["Earlier member replies to this message:", ...said] : []));
  if (plan.mode === "sequential") {
    out.push(`This is an execution task; proceed in order: ${order}.`, partRule(member, opening, false, hostId, names[hostId]));
    if (presets[member] === "planner") out.push("You own planning. Put the plan in your reply; the host passes it in full to the next member. Do not create separate plan or handoff files unless explicitly requested. "
      + "Shared directories are shared/plans, shared/handoffs and shared/artifacts. Read relevant files when current state is needed. Keep the requested scope.");
    if (presets[member] === "builder") out.push("You own implementation. Follow the user’s request and plan without expanding scope. Match verification to the changes. Do not add screenshots, rendering, printing or handoff files unless the plan or user requests them.");
    for (const p of previous) out.push(`Full output from ${names[p.member]} this turn:\n${p.text}`);
  }
  out.push(`Current user request:\n${text}`);
  return out.join("\n\n");
}

const GREETING = /^\s*(hi|hello|hey|hiya|yo|こんにちは|こんばんは|おはようございます|おはよう|はじめまして|皆さんこんにちは|みなさんこんにちは|你好|您好|嗨|哈喽|哈啰|大家好|各位好|你们好|早上好|早安|晚上好|下午好|在吗|在不在)(\s*(everyone|all|guys|大家|各位|呀|啊|哦|～|~|!|！|。|\.|,|，))*\s*$/i;

export const isGreeting = (text: string) => GREETING.test(text);

export function introPrompt(member: string, members: string[], previous: { member: string; text: string }[], text: string, joined: boolean, names = MEMBER_NAMES, roles = MEMBER_ROLES): string {
  return [
    joined
      ? `[Group conversation] You are ${names[member]} (${roles[member]}), newly added. Introduce yourself and your role in one sentence only. The user’s request will be handled separately afterward.`
      : `[Group conversation] You are ${names[member]} (${roles[member]}). The user greeted this new group. Respond in one or two sentences and describe your role. Continue from earlier speakers without repeating them.`,
    `Members: ${roster(members, names, roles)}, plus the user. Do not call tools or read or write files.`,
    ...(previous.length ? ["Earlier speakers:", ...previous.map((p) => `- ${names[p.member]}：${p.text}`)] : []),
    `Current user request (language context; do not execute it during the introduction):\n${text}`,
  ].join("\n\n");
}

export const groupTitle = (members: string[], names = MEMBER_NAMES) => ["我", ...members.map((m) => names[m])].join("、");

export function pmAnnouncePrompt(plan: GroupPlan, lines: GroupLine[], text: string, names = MEMBER_NAMES, hostId = "assistant"): string {
  const order = plan.members.map((m) => names[m]).join(" → ");
  const recent = lines.slice(-6).map((l) => `- ${l.author === "user" ? "User" : names[l.author]}：${l.text.slice(0, 600)}`);
  return [
    `[Group PM] You are ${names[hostId]}, coordinating this turn. The user’s request needs several members. The assignments are fixed: ` + order + ".",
    "In one or two sentences, explain who acts first, who follows, and that you will summarize. End by asking whether to start, in the user’s reply language, then stop. Do not perform the request or call tools.",
    ...(recent.length ? ["Recent group messages (quoted context):", ...recent] : []),
    `Current user request:\n${text}`,
  ].join("\n\n");
}

export function pmSummaryPrompt(outputs: { member: string; text: string }[], text: string, discussion = false, names = MEMBER_NAMES, hostId = "assistant"): string {
  return [
    discussion
      ? `[Group discussion summary] You are ${names[hostId]}. Discussion is finished. Summarize in 3–5 lines: agreement, remaining differences and recommended next steps. Do not call tools or repeat full replies.`
      : `[Group PM summary] You are ${names[hostId]}. Members have finished. Summarize in 3–5 lines: completed work, output locations, unfinished work and user decisions needed. Do not call tools or repeat full replies.`,
    `Current user request:\n${text}`,
    ...outputs.map((o) => `Output from ${names[o.member]}:\n${o.text.slice(0, 6000)}`),
  ].join("\n\n");
}
