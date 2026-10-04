import { randomUUID } from "node:crypto";

import { errorMessage } from "./channelBridge.ts";
import type { ChannelManager } from "./channelManager.ts";
import { CHAT_SETUP_PLATFORMS, type ChannelPlatform, type ChannelSetupState } from "./types.ts";

export type ChannelSetupResult =
  | { status: "connected"; platform: ChannelPlatform; bot?: string; allowedUser?: string }
  | { status: "cancelled" | "unsupported" | "open_in_browser"; platform: ChannelPlatform; message?: string };

export type ChannelSetupRun = {
  conversationId: string;
  platform: ChannelPlatform;
  signal: AbortSignal;
  /** The turn came from an IM chat. Where the turn came from decides, not the conversation: a
   *  Telegram-started conversation opened in the web app still gets the card. */
  fromChannel: boolean;
  /** Shows a stage in the chat (never a credential). */
  announce(requestId: string, state: ChannelSetupState): void;
  resolved(requestId: string): void;
};

type Entry = {
  conversationId: string;
  state: ChannelSetupState;
  show(state: ChannelSetupState): void;
  startPairing(botName?: string): void;
  finish(result: ChannelSetupResult): void;
};

/** Owner pairing waits this long for the first message to the new bot, then finishes without it. */
const PAIRING_MS = 15 * 60_000;

/**
 * Connecting a channel from chat (openclaw's `secrets request` and MCP URL-mode elicitation):
 * the agent asks, the browser posts the token straight here, and the agent only learns the
 * outcome. Pairing then allowlists the owner from their first message, after they confirm it.
 */
export function createChannelSetup(manager: ChannelManager) {
  const pending = new Map<string, Entry>();
  const entry = (conversationId: string, requestId: string) => {
    const found = pending.get(requestId);
    if (!found || found.conversationId !== conversationId) throw new ChannelSetupError("This setup is no longer active.", 409);
    return found;
  };

  return {
    run(input: ChannelSetupRun): Promise<ChannelSetupResult> {
      const { platform } = input;
      if (!CHAT_SETUP_PLATFORMS.includes(platform)) {
        return Promise.resolve({ status: "unsupported", platform, message: "Set this platform up in Settings → IM channels." });
      }
      // An IM chat cannot show the secure card, and a token typed there would reach the model.
      if (input.fromChannel) {
        return Promise.resolve({ status: "open_in_browser", platform, message: "Credentials are never accepted in chat. Ask Raer in the RaytoneBot web app, or use Settings → IM channels." });
      }
      const requestId = randomUUID();
      return new Promise<ChannelSetupResult>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unwatch: (() => void) | undefined;
        const current: Entry = {
          conversationId: input.conversationId,
          state: { platform, stage: "credentials" },
          show(state) { current.state = state; input.announce(requestId, state); },
          startPairing(botName) {
            current.show({ platform, stage: "pairing", botName });
            timer = setTimeout(() => current.finish({ status: "connected", platform, bot: botName }), PAIRING_MS);
            timer.unref();
            unwatch = manager.watchDenied(platform, (sender) => {
              if (current.state.candidate) return undefined;
              current.show({ ...current.state, candidate: sender });
              return "收到。请回到 RaytoneBot 网页上点「允许」完成配对。";
            });
          },
          finish(result) {
            if (!pending.delete(requestId)) return;
            clearTimeout(timer);
            unwatch?.();
            input.signal.removeEventListener("abort", abort);
            input.resolved(requestId);
            resolve(result);
          },
        };
        const abort = () => current.finish({ status: "cancelled", platform });
        input.signal.addEventListener("abort", abort, { once: true });
        pending.set(requestId, current);
        if (input.signal.aborted) abort();
        else current.show(current.state);
      });
    },

    /** The browser's answer. `fields` holds the credentials; they go to the channel store only. */
    async answer(conversationId: string, requestId: string, action: "submit" | "allow" | "reject" | "skip", fields?: Record<string, string>): Promise<ChannelSetupState | undefined> {
      const current = entry(conversationId, requestId);
      const { platform, stage, candidate } = current.state;
      if (action === "skip") {
        current.finish(stage === "credentials" ? { status: "cancelled", platform } : { status: "connected", platform, bot: current.state.botName });
        return undefined;
      }
      if (action === "submit") {
        if (stage !== "credentials") throw new ChannelSetupError("Already connected.", 409);
        try {
          const view = await manager.connect(platform, { fields: fields ?? {} });
          current.startPairing(view.status.botName);
          return current.state;
        } catch (error) {
          current.show({ platform, stage: "credentials", error: errorMessage(error) });
          throw new ChannelSetupError(errorMessage(error), 400);
        }
      }
      if (stage !== "pairing" || !candidate) throw new ChannelSetupError("Nobody has messaged the bot yet.", 409);
      if (action === "reject") {
        current.show({ platform, stage: "pairing", botName: current.state.botName });
        return current.state;
      }
      manager.allow(platform, candidate.id);
      current.finish({ status: "connected", platform, bot: current.state.botName, allowedUser: candidate.name ?? candidate.id });
      return undefined;
    },
  };
}

export class ChannelSetupError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
