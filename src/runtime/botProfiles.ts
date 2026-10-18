import { isAgentPresetId, type AgentPresetId } from "../pi/harnessCatalog.ts";
import { DEFAULT_BOTS, parseBotAppearance, type BotAppearance, type BotAppearances, type BotKind } from "./botAppearance.ts";

export type BotProfile = { id: string; presetId: AgentPresetId; name: string; appearance: BotAppearance };
export type BotProfileStore = { profiles: BotProfile[]; conversations: Record<string, string> };
export const BOT_PROFILES_KEY = "raytone.bot-profiles.v1";
export const BOT_KINDS = { assistant: "woman", planner: "man", builder: "boy" } as const satisfies Record<AgentPresetId, BotKind>;
export const BOT_NAMES = { assistant: "Raer", planner: "Tonny", builder: "Bob" };
export const BOT_NAME_LIMIT = 40;
const customId = /^bot_[a-f0-9-]{36}$/;

export function parseBotProfile(value: unknown): BotProfile | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  const appearance = parseBotAppearance(data.appearance);
  if (typeof data.id !== "string" || (!isAgentPresetId(data.id) && !customId.test(data.id))
    || !isAgentPresetId(data.presetId) || (isAgentPresetId(data.id) && data.id !== data.presetId)
    || typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > BOT_NAME_LIMIT || !appearance) return;
  return { id: data.id, presetId: data.presetId, name: data.name.trim(), appearance };
}

export function parseBotProfiles(raw: string | null): BotProfileStore {
  const empty: BotProfileStore = { profiles: [], conversations: {} };
  try {
    const data = JSON.parse(raw ?? "{}");
    if (!data || typeof data !== "object") return empty;
    const profiles = new Map<string, BotProfile>();
    for (const value of Array.isArray(data.profiles) ? data.profiles : []) {
      const bot = parseBotProfile(value);
      if (bot) profiles.set(bot.id, bot);
    }
    const conversations = Object.fromEntries(Object.entries(data.conversations ?? {}).filter(([id, bot]) =>
      /^[a-zA-Z0-9._:-]{1,160}$/.test(id) && !id.startsWith("group_")
      && typeof bot === "string" && (isAgentPresetId(bot) || profiles.has(bot))));
    return { profiles: [...profiles.values()], conversations: conversations as Record<string, string> };
  } catch { return empty; }
}

export function resolveBotProfiles(store: BotProfileStore, legacy: BotAppearances = {}): BotProfile[] {
  return [
    ...(["assistant", "planner", "builder"] as const).map(presetId => store.profiles.find(bot => bot.id === presetId) ?? {
      id: presetId, presetId, name: BOT_NAMES[presetId], appearance: legacy[BOT_KINDS[presetId]] ?? DEFAULT_BOTS[BOT_KINDS[presetId]],
    }),
    ...store.profiles.filter(bot => !isAgentPresetId(bot.id)),
  ];
}

/** Keep the original engine immutable: editing a face must never move existing context or permissions. */
export function updateBotProfile(store: BotProfileStore, value: BotProfile): BotProfileStore {
  const bot = parseBotProfile(value);
  if (!bot) throw new Error("Invalid Bot profile");
  const previous = store.profiles.find(entry => entry.id === bot.id);
  if (previous && previous.presetId !== bot.presetId) throw new Error("A Bot's engine cannot change");
  return { ...store, profiles: previous ? store.profiles.map(entry => entry.id === bot.id ? bot : entry) : [...store.profiles, bot] };
}

export function conversationBotId(store: BotProfileStore, conversation: { id: string; agentPreset?: string }): string | undefined {
  if (conversation.id.startsWith("group_")) return;
  return store.conversations[conversation.id] ?? (isAgentPresetId(conversation.agentPreset) ? conversation.agentPreset : undefined);
}
