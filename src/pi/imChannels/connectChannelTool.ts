import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { ChannelSetupResult } from "./channelSetup.ts";
import { CHANNEL_PLATFORMS, type ChannelPlatform } from "./types.ts";

export type ChannelSetupRequest = { toolCallId: string; platform: ChannelPlatform; signal: AbortSignal };

/** No credential parameter on purpose: the user types the token into a card the model never sees. */
export function connectChannelTool(setup: (request: ChannelSetupRequest) => Promise<ChannelSetupResult>) {
  return defineTool({
    name: "connect_channel", label: "Connect IM channel",
    description: "Connect RaytoneBot to a chat app. Shows the user a secure card for the bot token, then pairs their account. Returns only the outcome.",
    promptGuidelines: ["When the user wants to connect Telegram, explain how to get a token from @BotFather in one line, then call connect_channel. Never ask them to paste a token or user ID into the conversation. If they already did, tell them to revoke it in @BotFather (/revoke) and use the card."],
    executionMode: "sequential",
    parameters: Type.Object({ platform: Type.Union(CHANNEL_PLATFORMS.map((platform) => Type.Literal(platform))) }),
    async execute(toolCallId, params, signal) {
      const result = await setup({ toolCallId, platform: params.platform, signal: signal ?? new AbortController().signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
