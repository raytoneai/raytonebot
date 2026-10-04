import type { AgentPresetId } from "../harnessCatalog.ts";
import type { PiProviderDefinition } from "../piClient.ts";

/**
 * IM channels: the bot answers in Feishu, DingTalk, WeCom or Telegram as well as in the browser.
 * Every platform here connects outward (long connection or long polling), so a sandbox without a
 * public URL can host it. Shared by the server and the settings page; no Node imports.
 */
export const CHANNEL_PLATFORMS = ["feishu", "dingtalk", "wecom", "telegram"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/** Credential fields per platform. Secret fields never leave the server once saved. */
export const CHANNEL_FIELDS: Record<ChannelPlatform, readonly { key: string; secret: boolean }[]> = {
  feishu: [{ key: "appId", secret: false }, { key: "appSecret", secret: true }],
  dingtalk: [{ key: "clientId", secret: false }, { key: "clientSecret", secret: true }],
  wecom: [{ key: "botId", secret: false }, { key: "secret", secret: true }],
  telegram: [{ key: "botToken", secret: true }],
};

export type ChannelAccess = "allowlist" | "open";

/** What a turn started from IM runs with. Keys still come from the server env, never from here. */
export type ChannelModel = { definition: PiProviderDefinition; model: string };

export type ChannelConnectionState = "off" | "connecting" | "connected" | "error";

/** One channel as the settings page sees it: secrets reported only as set or not. */
export type ChannelView = {
  platform: ChannelPlatform;
  enabled: boolean;
  /** Non-secret fields verbatim; secret fields as "" (with `secretsSet` telling whether saved). */
  fields: Record<string, string>;
  secretsSet: Record<string, boolean>;
  access: ChannelAccess;
  allowUsers: string[];
  agentPreset: AgentPresetId;
  model?: { provider: string; model: string };
  status: { state: ChannelConnectionState; error?: string; botName?: string; since?: number };
  /** Senders turned away by the allowlist, newest first, so the owner can let them in. */
  denied: { id: string; name?: string; at: number }[];
};

export type ChannelPatch = {
  enabled?: boolean;
  /** Empty string keeps a saved secret; non-secret fields are replaced as given. */
  fields?: Record<string, string>;
  access?: ChannelAccess;
  allowUsers?: string[];
  agentPreset?: AgentPresetId;
  model?: ChannelModel;
};
