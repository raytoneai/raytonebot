import { splitText, type Replier } from "../channelBridge.ts";
import { withTimeout, type ChannelConnector, type ConnectorInput } from "./connector.ts";

/** Card markdown stays well under Feishu's ~30 KB card limit. */
const LIMIT = 8000;

/**
 * Feishu self-built app over the SDK's long connection (events set to "use long connection" in
 * the developer console). Replies are a markdown card patched in place while the turn runs.
 * Connection pattern after dsh-im (MIT).
 */
export function feishuConnector(input: ConnectorInput): ChannelConnector {
  let ws: { close(params?: { force?: boolean }): void } | undefined;
  return {
    async start() {
      const { appId = "", appSecret = "" } = input.credentials;
      if (!appId || !appSecret) throw new Error("App ID and App Secret are required.");
      const lark = await import("@larksuiteoapi/node-sdk");
      const config = { appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error };
      const client = new lark.Client(config);
      // Verifies the credentials and learns the bot's open_id, which tells a mention of the bot apart.
      const info = await client.request<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>({ method: "GET", url: "/open-apis/bot/v3/info" });
      if (info.code) throw new Error(`Feishu: ${info.msg ?? info.code}`);
      const botOpenId = info.bot?.open_id;

      const card = (text: string) => JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, elements: [{ tag: "markdown", content: text || " " }] });
      const replyCard = async (messageId: string, text: string) => {
        const result = await client.im.v1.message.reply({ path: { message_id: messageId }, data: { msg_type: "interactive", content: card(text) } });
        if (result.code) throw new Error(`Feishu reply: ${result.msg}`);
        return result.data?.message_id;
      };

      const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
        "im.message.receive_v1": (event: FeishuMessageEvent) => {
          const message = event.message;
          if (message.message_type !== "text" || event.sender.sender_type !== "user") return;
          let text = "";
          try { text = String(JSON.parse(message.content).text ?? ""); } catch { return; }
          for (const mention of message.mentions ?? []) text = text.replaceAll(mention.key, "");
          const group = message.chat_type !== "p2p";
          const reply: Replier = {
            async send(body) {
              for (const piece of splitText(body, LIMIT)) await replyCard(message.message_id, piece);
            },
            async stream(initial) {
              const id = await replyCard(message.message_id, initial);
              const patch = async (body: string) => {
                if (!id) return;
                const result = await client.im.v1.message.patch({ path: { message_id: id }, data: { content: card(body.slice(0, LIMIT)) } });
                if (result.code) throw new Error(`Feishu update: ${result.msg}`);
              };
              return {
                update: patch,
                async finish(body) {
                  const [first, ...rest] = splitText(body, LIMIT);
                  await patch(first);
                  for (const piece of rest) await replyCard(message.message_id, piece);
                },
              };
            },
          };
          input.onMessage({
            messageId: message.message_id,
            chatId: message.chat_id,
            chatType: group ? "group" : "direct",
            senderId: event.sender.sender_id?.open_id ?? "",
            text: text.trim(),
            mentioned: !group || (message.mentions ?? []).some((mention) => mention.id?.open_id === botOpenId),
            reply,
          });
        },
      });

      let ready!: () => void;
      let failed!: (error: Error) => void;
      const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
      let started = false;
      const socket = new lark.WSClient({
        ...config,
        handshakeTimeoutMs: 15_000,
        onReady: () => { started = true; ready(); },
        onError: (error: Error) => { if (started) input.onState("error", error.message); else failed(error); },
        onReconnecting: () => input.onState("connecting"),
        onReconnected: () => input.onState("connected"),
      });
      ws = socket;
      void socket.start({ eventDispatcher: dispatcher }).catch((error: Error) => failed(error));
      try {
        await withTimeout(connected, 20_000, "Feishu long connection timed out. Check that events use long-connection mode.");
      } catch (error) {
        socket.close({ force: true });
        throw error;
      }
      return { botName: info.bot?.app_name };
    },
    stop() {
      ws?.close({ force: true });
      ws = undefined;
    },
  };
}

type FeishuMessageEvent = {
  sender: { sender_type?: string; sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id?: { open_id?: string } }[];
  };
};
