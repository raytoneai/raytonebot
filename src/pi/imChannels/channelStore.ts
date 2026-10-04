import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isAgentPresetId, type AgentPresetId } from "../harnessCatalog.ts";
import { CHANNEL_FIELDS, CHANNEL_PLATFORMS, type ChannelAccess, type ChannelModel, type ChannelPatch, type ChannelPlatform } from "./types.ts";

export type ChannelSettings = {
  enabled: boolean;
  credentials: Record<string, string>;
  access: ChannelAccess;
  allowUsers: string[];
  agentPreset: AgentPresetId;
  model?: ChannelModel;
};

type ChannelFile = {
  channels: Partial<Record<ChannelPlatform, ChannelSettings>>;
  /** `platform:chat` → the product conversation its messages continue. */
  chats: Record<string, string>;
  /** Telegram's getUpdates cursor, so a restart neither replays nor skips messages. */
  telegramOffset?: number;
};

/**
 * Channel settings, credentials and chat → conversation bindings, in one 0600 file inside the
 * bot's data directory. Agents cannot read that directory (UID isolation in the sandbox, the
 * secret-path list elsewhere), the same place approval grants live.
 */
export class ChannelStore {
  private data: ChannelFile = { channels: {}, chats: {} };
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ChannelFile>;
      for (const platform of CHANNEL_PLATFORMS) {
        const saved = parsed.channels?.[platform];
        if (saved) this.data.channels[platform] = normalize(platform, saved);
      }
      if (parsed.chats && typeof parsed.chats === "object") {
        this.data.chats = Object.fromEntries(Object.entries(parsed.chats).filter(([, id]) => typeof id === "string"));
      }
      if (Number.isSafeInteger(parsed.telegramOffset)) this.data.telegramOffset = parsed.telegramOffset;
    } catch {
      // Missing or unreadable: every channel starts off. Nothing connects until saved again.
    }
  }

  get(platform: ChannelPlatform): ChannelSettings {
    return this.data.channels[platform] ?? normalize(platform, {});
  }

  update(platform: ChannelPlatform, patch: ChannelPatch): ChannelSettings {
    const current = this.get(platform);
    const credentials = { ...current.credentials };
    for (const { key, secret } of CHANNEL_FIELDS[platform]) {
      const value = patch.fields?.[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (secret && !trimmed) continue;
      credentials[key] = trimmed;
    }
    const next = normalize(platform, {
      ...current,
      credentials,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.access ? { access: patch.access } : {}),
      ...(patch.allowUsers ? { allowUsers: patch.allowUsers } : {}),
      ...(patch.agentPreset ? { agentPreset: patch.agentPreset } : {}),
      ...(patch.model ? { model: patch.model } : {}),
    });
    this.data.channels[platform] = next;
    this.save();
    return next;
  }

  /** Puts back settings read earlier with `get`, credentials included (undoing a failed connect). */
  restore(platform: ChannelPlatform, settings: ChannelSettings) {
    this.data.channels[platform] = normalize(platform, settings);
    this.save();
  }

  conversationFor(chatKey: string): string | undefined {
    return this.data.chats[chatKey];
  }

  bindConversation(chatKey: string, conversationId: string) {
    this.data.chats[chatKey] = conversationId;
    this.save();
  }

  get telegramOffset(): number | undefined {
    return this.data.telegramOffset;
  }

  set telegramOffset(offset: number) {
    this.data.telegramOffset = offset;
    this.save();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

function normalize(platform: ChannelPlatform, value: Partial<ChannelSettings>): ChannelSettings {
  const credentials: Record<string, string> = {};
  for (const { key } of CHANNEL_FIELDS[platform]) {
    const field = value.credentials?.[key];
    if (typeof field === "string" && field) credentials[key] = field;
  }
  const model = value.model && typeof value.model.model === "string" && typeof value.model.definition?.id === "string"
    && typeof value.model.definition.baseUrl === "string" ? value.model : undefined;
  return {
    enabled: value.enabled === true,
    credentials,
    // Agents run tools in the sandbox: nobody but listed users gets in unless the owner opens it.
    access: value.access === "open" ? "open" : "allowlist",
    allowUsers: [...new Set((Array.isArray(value.allowUsers) ? value.allowUsers : [])
      .filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))].slice(0, 100),
    agentPreset: isAgentPresetId(value.agentPreset) ? value.agentPreset : "assistant",
    ...(model ? { model } : {}),
  };
}
