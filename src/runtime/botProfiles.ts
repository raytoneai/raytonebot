import { DEFAULT_BOT_NAMES, isAgentPresetId, type AgentPresetId } from "../pi/harnessCatalog.ts";
import { DEFAULT_BOTS, parseBotAppearance, parseBotAppearances, type BotAppearance, type BotAppearances, type BotKind } from "./botAppearance.ts";

export type BotProfile = {
  id: string; presetId: AgentPresetId; name: string; appearance: BotAppearance;
  role?: string; personality?: string; instructions?: string;
  model?: { provider: string; model: string };
  /** Missing retains the legacy all-enabled-servers behavior; [] explicitly selects none. */
  mcpServerIds?: string[];
  skillIds?: string[];
};
export type BotConfigView = { revision: number; profiles: BotProfile[] };
export type BotProfileStore = { profiles: BotProfile[]; conversations: Record<string, string> };
export const BOT_PROFILES_KEY = "raytone.bot-profiles.v1";
export const BOT_KINDS = { assistant: "woman", planner: "man", builder: "boy", dsh: "woman" } as const satisfies Record<AgentPresetId, BotKind>;
export const BOT_NAMES = DEFAULT_BOT_NAMES;
export const BOT_NAME_LIMIT = 40;
export const BOT_PERSONA_LIMITS = { role: 300, personality: 1000, instructions: 4000 } as const;
const customId = /^bot_[a-f0-9-]{36}$/;

export function parseBotProfile(value: unknown): BotProfile | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  const appearance = parseBotAppearance(data.appearance);
  if (typeof data.id !== "string" || (!isAgentPresetId(data.id) && !customId.test(data.id))
    || !isAgentPresetId(data.presetId) || (isAgentPresetId(data.id) && data.id !== data.presetId)
    || typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > BOT_NAME_LIMIT || /[\r\n\u0000-\u001f]/.test(data.name) || !appearance) return;
  const persona: Pick<BotProfile, "role" | "personality" | "instructions"> = {};
  for (const key of Object.keys(BOT_PERSONA_LIMITS) as (keyof typeof BOT_PERSONA_LIMITS)[]) {
    const text = data[key];
    if (text !== undefined && (typeof text !== "string" || text.length > BOT_PERSONA_LIMITS[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))) return;
    if (typeof text === "string" && text.trim()) persona[key] = text.trim();
  }
  let model: BotProfile["model"];
  if (data.model !== undefined) {
    const value = data.model as BotProfile["model"];
    if (!value || typeof value.provider !== "string" || typeof value.model !== "string"
      || !value.provider.trim() || !value.model.trim() || value.provider.length > 128 || value.model.length > 256
      || /[\u0000-\u001f]/.test(value.provider + value.model)) return;
    model = { provider: value.provider.trim(), model: value.model.trim() };
  }
  const capabilities: Pick<BotProfile, "mcpServerIds" | "skillIds"> = {};
  for (const key of ["mcpServerIds", "skillIds"] as const) {
    const values = data[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 100 || values.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) return;
    capabilities[key] = [...new Set(values)] as string[];
  }
  return { id: data.id, presetId: data.presetId, name: data.name.trim(), appearance, ...persona, ...(model ? { model } : {}), ...capabilities };
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
    ...store.profiles.filter(bot => !["assistant", "planner", "builder"].includes(bot.id)),
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

export function conversationBotId(store: BotProfileStore, conversation: { id: string; botId?: string; agentPreset?: string }): string | undefined {
  if (conversation.id.startsWith("group_")) return;
  return conversation.botId ?? store.conversations[conversation.id] ?? (isAgentPresetId(conversation.agentPreset) ? conversation.agentPreset : undefined);
}

/** A server display cache must never be mistaken for an older browser's editable configuration. */
export function legacyBotImport(raw: string | null, appearances: string | null): BotProfileStore | undefined {
  try { if (raw && JSON.parse(raw)?.source === "server") return; } catch { /* Validate with the legacy readers. */ }
  if (!raw && !appearances) return;
  const store = parseBotProfiles(raw);
  return { ...store, profiles: resolveBotProfiles(store, parseBotAppearances(appearances)) };
}
