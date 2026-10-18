import type { AgentUXEvent } from "@agent-ux/protocol";
import { isAgentPresetId, type AgentPresetId } from "./harnessCatalog.ts";

export type GroupParticipant = { id: string; name: string; presetId: AgentPresetId };
export const DEFAULT_PARTICIPANTS: GroupParticipant[] = [
  { id: "assistant", name: "Raer", presetId: "assistant" },
  { id: "planner", name: "Tonny", presetId: "planner" },
  { id: "builder", name: "Bob", presetId: "builder" },
];
export const validParticipantId = (id: unknown): id is string => typeof id === "string"
  && (isAgentPresetId(id) || /^bot_[a-f0-9-]{36}$/.test(id));

/** Names identify people in the room; presets select existing engines and permissions. */
export function participantCatalog(value: unknown, previous: readonly GroupParticipant[] = DEFAULT_PARTICIPANTS): GroupParticipant[] {
  if (value === undefined) return [...previous];
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid Bot catalog.");
  const result = new Map(previous.map(bot => [bot.id, bot]));
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || !validParticipantId(entry.id) || !isAgentPresetId(entry.presetId)
      || (isAgentPresetId(entry.id) && entry.id !== entry.presetId) || typeof entry.name !== "string"
      || !entry.name.trim() || entry.name.trim().length > 40 || /[\r\n\u0000-\u001f]/.test(entry.name) || seen.has(entry.id)) throw new Error("Invalid Bot identity.");
    if (result.has(entry.id) && result.get(entry.id)!.presetId !== entry.presetId) throw new Error("A Bot's engine cannot change.");
    result.set(entry.id, { id: entry.id, name: entry.name.trim(), presetId: entry.presetId });
    seen.add(entry.id);
  }
  return [...result.values()];
}

export function selectedParticipants(ids: unknown, catalog: readonly GroupParticipant[]): GroupParticipant[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error("Choose 1–8 different Bots.");
  return ids.map(id => {
    const bot = catalog.find(bot => bot.id === id);
    if (!bot) throw new Error("A selected Bot is unavailable. Choose it again.");
    return bot;
  });
}

export const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namePattern = (name: string) => `(?<![A-Za-z0-9_])@?${escapeName(name)}(?![A-Za-z0-9_])`;

/** Only explicit invitations in the user's message change membership. Mentions and quotations do not. */
export function invitedParticipants(text: string, catalog: readonly GroupParticipant[]): GroupParticipant[] {
  const plain = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|"[^"]*"/g, "");
  const clauses = plain.split(/[。！？!?;；\n]/).filter(clause => !/不要|别|不必|不用|不想|勿|don't|do not|not to/i.test(clause));
  const name = `(?:${catalog.map(bot => namePattern(bot.name)).join("|")})`;
  const list = `(${name}(?:\\s*(?:和|与|跟|、|,|，|&|and)\\s*${name})*)`;
  const patterns = [
    `(?:把\\s*)?${list}\\s*(?:也|一起)?\\s*(?:拉|加|邀请|请)\\s*(?:进来|进群|到群里|入群|加入(?:聊天|群聊|讨论))`,
    `(?:拉上|叫上|邀请|请|加入)\\s*${list}(?:\\s*(?:进来|进群|一起|加入|来|看看|讨论|参与)|\\s*$)`,
    `\\b(?:invite|add|bring)\\s+${list}(?:\\s+(?:in|into|to|over)|\\s*$)`,
  ];
  const ids = new Set(clauses.flatMap(clause => patterns.flatMap(pattern =>
    [...clause.matchAll(new RegExp(pattern, "giu"))].flatMap(match => namedParticipants(match[1], catalog)))));
  const invited = catalog.filter(bot => ids.has(bot.id));
  for (const bot of invited) if (catalog.filter(other => other.name.toLocaleLowerCase() === bot.name.toLocaleLowerCase()).length > 1) {
    throw new Error(`有多个 Bot 叫 ${bot.name}，请用聊天顶部的 ＋ 选择。`);
  }
  return invited;
}

export function namedParticipants(text: string, members: readonly GroupParticipant[], mentionOnly = false): string[] {
  return members.map(bot => ({ id: bot.id, at: text.search(new RegExp(mentionOnly
    ? `(?<![A-Za-z0-9._%+-])@${escapeName(bot.name)}(?![A-Za-z0-9_])` : namePattern(bot.name), "iu")) }))
    .filter(item => item.at >= 0).sort((a, b) => a.at - b.at).map(item => item.id);
}

/** Seed a promoted room from its real transcript; no native sessions or files are copied. */
export function conversationGroupLines(events: readonly AgentUXEvent[], originalBot: string): { author: string; text: string }[] {
  const messages = new Map<string, { author: string; text: string }>();
  for (const event of events) {
    const id = event.payload.textId;
    if (typeof id !== "string") continue;
    if (event.type === "text.started" && ["user", "assistant"].includes(String(event.payload.role))) {
      messages.set(id, { author: event.payload.role === "user" ? "user" : originalBot, text: "" });
    } else if (event.type === "text.delta" && typeof event.payload.delta === "string" && messages.has(id)) {
      messages.get(id)!.text += event.payload.delta;
    }
  }
  return [...messages.values()].filter(line => line.text.trim()).slice(-20).map(line => ({ ...line, text: line.text.slice(0, 4000) }));
}
