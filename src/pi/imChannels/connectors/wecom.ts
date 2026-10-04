import { errorMessage, splitText, type Replier } from "../channelBridge.ts";
import { withTimeout, type ChannelConnector, type ConnectorInput } from "./connector.ts";

/** A stream frame is capped at 20 KB of UTF-8; Chinese text is up to 3 bytes a character. */
const LIMIT = 6000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * WeCom smart bot (智能机器人) over its official long connection. Replies use the native stream
 * message, sent cumulatively; overflow and late replies go out as markdown messages.
 * Connection pattern after dsh-im (MIT).
 */
export function wecomConnector(input: ConnectorInput): ChannelConnector {
  let client: { disconnect(): void } | undefined;
  return {
    async start() {
      const { botId = "", secret = "" } = input.credentials;
      if (!botId || !secret) throw new Error("Bot ID and Secret are required.");
      const sdk = await import("@wecom/aibot-node-sdk");
      const ws = new sdk.WSClient({ botId, secret, logger: silent, maxReconnectAttempts: -1, maxAuthFailureAttempts: 1 });
      let started = false;
      let ready!: () => void;
      let failed!: (error: Error) => void;
      const authenticated = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
      ws.on("authenticated", () => {
        if (started) input.onState("connected");
        started = true;
        ready();
      });
      ws.on("disconnected", () => { if (started) input.onState("connecting"); });
      ws.on("error", (error: Error) => { if (started) input.onState("error", errorMessage(error)); else failed(error); });
      ws.on("message", (frame: WecomFrame) => {
        const body = frame.body ?? {};
        if (body.msgtype !== "text" || !body.msgid || !body.from?.userid) return;
        const group = body.chattype === "group";
        const target = group ? body.chatid! : body.from.userid;
        const send = async (text: string) => {
          for (const piece of splitText(text, LIMIT)) await ws.sendMessage(target, { msgtype: "markdown", markdown: { content: piece } });
        };
        const reply: Replier = {
          send,
          async stream(initial) {
            const streamId = sdk.generateReqId("stream");
            await ws.replyStream(frame as never, streamId, initial, false);
            return {
              async update(text) { await ws.replyStream(frame as never, streamId, text.slice(0, LIMIT), false); },
              async finish(text) {
                const [first, ...rest] = splitText(text, LIMIT);
                await ws.replyStream(frame as never, streamId, first, true);
                for (const piece of rest) await send(piece);
              },
            };
          },
        };
        input.onMessage({
          messageId: body.msgid,
          chatId: target,
          chatType: group ? "group" : "direct",
          senderId: body.from.userid,
          // Group text starts with the bot's @name; smart bots only receive messages that @ them.
          text: (body.text?.content ?? "").replace(group ? /^@\S+\s*/ : /^$/, "").trim(),
          mentioned: true,
          reply,
        });
      });
      client = ws;
      ws.connect();
      try {
        await withTimeout(authenticated, 20_000, "WeCom long connection timed out.");
      } catch (error) {
        ws.disconnect();
        throw error;
      }
      return {};
    },
    stop() {
      client?.disconnect();
      client = undefined;
    },
  };
}

type WecomFrame = {
  headers?: { req_id?: string };
  body?: {
    msgid?: string;
    msgtype?: string;
    chattype?: string;
    chatid?: string;
    from?: { userid?: string };
    text?: { content?: string };
  };
};
