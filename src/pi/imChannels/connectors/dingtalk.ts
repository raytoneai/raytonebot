import { errorMessage, splitText, type Replier } from "../channelBridge.ts";
import { sleep, type ChannelConnector, type ConnectorInput } from "./connector.ts";

const LIMIT = 4000;
const API = "https://api.dingtalk.com";

/**
 * DingTalk enterprise robot in Stream mode. DingTalk cannot edit a sent robot message, so each
 * reply is a new markdown message: through the message's session webhook while it is valid,
 * then the robot OpenAPI. The SDK's own reconnect can leave an unhandled rejection, so this
 * reconnects itself (as dsh-im does).
 */
export function dingtalkConnector(input: ConnectorInput, fetcher: typeof fetch = fetch): ChannelConnector {
  const stopped = new AbortController();
  let client: { disconnect(): void } | undefined;
  return {
    async start() {
      const { clientId = "", clientSecret = "" } = input.credentials;
      if (!clientId || !clientSecret) throw new Error("Client ID and Client Secret are required.");
      const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");
      // `autoReconnect` is read from the constructor options, though the typings omit it.
      const dw = new DWClient({ clientId, clientSecret, keepAlive: true, autoReconnect: false } as ConstructorParameters<typeof DWClient>[0]);
      let token: { value: string; until: number } | undefined;
      const accessToken = async () => {
        if (!token || token.until < Date.now()) token = { value: await dw.getAccessToken(), until: Date.now() + 60 * 60_000 };
        return token.value;
      };
      await accessToken().catch(() => { throw new Error("DingTalk rejected the Client ID or Client Secret."); });
      const post = async (url: string, body: unknown) => {
        const response = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({})) as { errcode?: number; errmsg?: string; code?: string; message?: string };
        if (!response.ok || (data.errcode !== undefined && data.errcode !== 0)) throw new Error(`DingTalk: ${data.errmsg ?? data.message ?? `HTTP ${response.status}`}`);
      };

      dw.registerCallbackListener(TOPIC_ROBOT, (event) => {
        // Acknowledge at once; DingTalk redelivers anything unanswered for 60 s.
        dw.socketCallBackResponse(event.headers.messageId, { success: true });
        let message: DingtalkMessage;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.msgtype !== "text") return;
        const group = message.conversationType === "2";
        const markdown = (text: string) => ({ title: text.split("\n")[0].slice(0, 30) || "RaytoneBot", text });
        const sendOne = async (text: string) => {
          if (message.sessionWebhook && message.sessionWebhookExpiredTime > Date.now() + 5_000) {
            return post(message.sessionWebhook, { msgtype: "markdown", markdown: markdown(text) });
          }
          const body = { robotCode: message.robotCode || clientId, msgKey: "sampleMarkdown", msgParam: JSON.stringify(markdown(text)) };
          return group
            ? post(`${API}/v1.0/robot/groupMessages/send`, { ...body, openConversationId: message.conversationId })
            : post(`${API}/v1.0/robot/oToMessages/batchSend`, { ...body, userIds: [message.senderStaffId] });
        };
        const reply: Replier = {
          async send(text) {
            for (const piece of splitText(text, LIMIT)) await sendOne(piece);
          },
        };
        input.onMessage({
          messageId: message.msgId,
          chatId: message.conversationId,
          chatType: group ? "group" : "direct",
          senderId: message.senderStaffId || message.senderId,
          senderName: message.senderNick,
          text: message.text?.content?.trim() ?? "",
          // Stream robots only receive group messages that @ them.
          mentioned: !group || message.isInAtList !== false,
          reply,
        });
      });
      await dw.connect();
      client = dw;
      void (async () => {
        let down = false;
        while (!stopped.signal.aborted) {
          await sleep(10_000, stopped.signal);
          if (stopped.signal.aborted) break;
          if ((dw as unknown as { connected: boolean }).connected) {
            if (down) { down = false; input.onState("connected"); }
            continue;
          }
          down = true;
          input.onState("connecting");
          try { await dw.connect(); } catch (error) { input.onState("error", errorMessage(error)); }
        }
      })();
      return {};
    },
    stop() {
      stopped.abort();
      client?.disconnect();
    },
  };
}

type DingtalkMessage = {
  msgId: string;
  msgtype: string;
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderStaffId: string;
  senderNick?: string;
  robotCode?: string;
  isInAtList?: boolean;
  sessionWebhook?: string;
  sessionWebhookExpiredTime: number;
  text?: { content?: string };
};
