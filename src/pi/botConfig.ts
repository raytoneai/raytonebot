import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseBotProfile, resolveBotProfiles, updateBotProfile, type BotProfile, type BotConfigView } from "../runtime/botProfiles.ts";
import { readSettingsFile } from "./settingsFile.ts";
import { resolveBotIdentity } from "./groupParticipants.ts";
import type { PiPromptInput } from "./piClient.ts";
import type { StoredConversation } from "./conversationStore.ts";

export class BotConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** The host owns names and faces; conversation catalogs are historical snapshots only. */
export class BotConfigStore {
  private data: BotConfigView = { revision: 0, profiles: [] };
  readonly error?: Error;
  private readonly file?: string;
  constructor(file?: string) {
    this.file = file;
    const loaded = readSettingsFile<BotConfigView>(file, value => Number.isSafeInteger(value.revision) && value.revision >= 0
      && Array.isArray(value.profiles) && value.profiles.length <= 100
      && value.profiles.every(bot => Boolean(parseBotProfile(bot)))
      && new Set(value.profiles.map(bot => bot.id)).size === value.profiles.length);
    this.error = loaded.error;
    if (loaded.data) this.data = loaded.data;
  }
  view(): BotConfigView {
    if (this.error) throw this.error;
    return { revision: this.data.revision, profiles: resolveBotProfiles({ profiles: structuredClone(this.data.profiles), conversations: {} }) };
  }
  catalog() { return this.view().profiles.map(({ id, name, presetId }) => ({ id, name, presetId })); }
  require(id: string) {
    const bot = this.view().profiles.find(bot => bot.id === id);
    if (!bot) throw new BotConfigError(`Unknown Bot: ${id}`);
    return bot;
  }
  save(value: unknown, revision: unknown) {
    this.view();
    if (revision !== this.data.revision) throw new BotConfigError("Bot 配置已在其他页面更新，请重新打开编辑后保存。", 409);
    const bot = parseBotProfile(value);
    if (!bot) throw new BotConfigError("Invalid Bot profile.");
    let next: BotProfile[];
    try { next = updateBotProfile({ profiles: this.data.profiles, conversations: {} }, bot).profiles; }
    catch (error) { throw new BotConfigError(error instanceof Error ? error.message : String(error)); }
    return this.write(next);
  }
  /** Imports only missing entries. Repeated imports and stale browsers never overwrite a saved Bot. */
  import(profiles: unknown) {
    this.view();
    if (!Array.isArray(profiles) || profiles.length > 100) throw new BotConfigError("Invalid Bot import.");
    const parsed = profiles.map(parseBotProfile);
    if (parsed.some(bot => !bot)) throw new BotConfigError("Invalid Bot import.");
    const next = new Map(this.data.profiles.map(bot => [bot.id, bot]));
    for (const bot of parsed as BotProfile[]) if (!next.has(bot.id)) next.set(bot.id, bot);
    return next.size === this.data.profiles.length ? this.view() : this.write([...next.values()]);
  }
  input(input: PiPromptInput, saved?: StoredConversation): PiPromptInput {
    const bot = this.require(input.botId ?? saved?.botId ?? input.agentPreset ?? saved?.agentPreset ?? "assistant");
    if (saved?.agentPreset && saved.agentPreset !== bot.presetId) throw new BotConfigError("A conversation’s engine cannot change.");
    if (input.agentPreset && input.agentPreset !== bot.presetId) throw new BotConfigError("Bot and engine do not match.");
    const identity = resolveBotIdentity(bot.presetId, { botId: bot.id, availableBots: this.catalog() }, saved ? { botId: saved.botId } : undefined);
    return { ...input, ...(bot.model ? { ...bot.model, claudeCodeModelSource: "provider" as const, codexModelSource: "provider" as const } : {}), agentPreset: bot.presetId, botId: identity.botId, availableBots: this.catalog() };
  }
  private write(profiles: BotProfile[]) {
    if (resolveBotProfiles({ profiles, conversations: {} }).length > 100) throw new BotConfigError("At most 100 Bots are supported.");
    const next = { revision: this.data.revision + 1, profiles };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    this.data = next;
    return this.view();
  }
}
