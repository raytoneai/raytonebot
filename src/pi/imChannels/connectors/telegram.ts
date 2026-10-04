import { errorMessage, splitText, type Replier } from "../channelBridge.ts";
import { sleep, type ChannelConnector, type ConnectorInput } from "./connector.ts";

const LIMIT = 4096;

/** Telegram Bot API over long polling: no webhook, no SDK. Polling pattern after dsh-im. */
export function telegramConnector(input: ConnectorInput, fetcher: typeof fetch = fetch): ChannelConnector {
  const token = input.credentials.botToken ?? "";
  const stopped = new AbortController();
  const api = async <T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${response.status}`}`);
    return data.result as T;
  };

  return {
    async start() {
      if (!token) throw new Error("Bot token is required.");
      const bot = await api<{ id: number; username?: string; first_name?: string }>("getMe");
      // A webhook makes getUpdates fail with 409; pending updates stay queued.
      await api("deleteWebhook", { drop_pending_updates: false });
      let offset: number | undefined = input.store.telegramOffset;
      if (offset === undefined) {
        // First start: skip the backlog rather than answering old messages.
        const last = await api<{ update_id: number }[]>("getUpdates", { offset: -1, timeout: 0 });
        offset = last.length ? last[last.length - 1].update_id + 1 : 0;
        input.store.telegramOffset = offset;
      }
      let cursor = offset;
      void (async () => {
        let failing = false;
        while (!stopped.signal.aborted) {
          try {
            const updates: TelegramUpdate[] = await api<TelegramUpdate[]>("getUpdates", { offset: cursor, timeout: 25, allowed_updates: ["message"] }, AbortSignal.any([stopped.signal, AbortSignal.timeout(40_000)]));
            if (failing) { failing = false; input.onState("connected"); }
            for (const update of updates) {
              cursor = update.update_id + 1;
              input.store.telegramOffset = cursor;
              const message = update.message;
              if (message?.text && message.from) input.onMessage(inbound(message, bot));
            }
          } catch (error) {
            if (stopped.signal.aborted) break;
            failing = true;
            input.onState("error", errorMessage(error));
            await sleep(5_000, stopped.signal);
          }
        }
      })();
      return { botName: bot.username ? `@${bot.username}` : bot.first_name };
    },
    stop() {
      stopped.abort();
    },
  };

  function inbound(message: TelegramMessage, bot: { id: number; username?: string }) {
    const group = message.chat.type !== "private";
    const mention = bot.username ? `@${bot.username}` : undefined;
    const text = message.text ?? "";
    const mentioned = !group || Boolean(mention && text.includes(mention)) || message.reply_to_message?.from?.id === bot.id;
    const chatId = message.chat.id;
    const replyTo = group ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {};
    const send = async (body: string) => {
      for (const piece of splitText(body, LIMIT)) await api("sendMessage", { chat_id: chatId, text: piece, ...replyTo });
    };
    const reply: Replier = {
      send,
      async stream(initial) {
        const sent = await api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: initial, ...replyTo });
        let shown = initial;
        const edit = async (body: string) => {
          const text = body.slice(0, LIMIT);
          if (text === shown) return;
          await api("editMessageText", { chat_id: chatId, message_id: sent.message_id, text });
          // Only once Telegram has it: after a failed edit, the same text must be sent again.
          shown = text;
        };
        return {
          update: edit,
          async finish(body) {
            const [first, ...rest] = splitText(body, LIMIT);
            await edit(first);
            for (const piece of rest) await api("sendMessage", { chat_id: chatId, text: piece });
          },
        };
      },
    };
    return {
      messageId: `${chatId}:${message.message_id}`,
      chatId: String(chatId),
      chatType: group ? "group" as const : "direct" as const,
      senderId: String(message.from!.id),
      senderName: message.from!.username ? `@${message.from!.username}` : message.from!.first_name,
      text: mention ? text.replaceAll(mention, "").trim() : text,
      mentioned,
      reply,
    };
  }
}

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  reply_to_message?: { from?: { id: number } };
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
