import { createHash, randomUUID } from "node:crypto";

import type { AgentUXEvent } from "@agent-ux/protocol";
import type { PiApprovalDecision } from "../../harness/adapters/piAdapter.ts";
import type { UserQuestion } from "../../runtime/userInput.ts";
import type { PiPermissionMode } from "../approvalGate.ts";
import type { runtimeLogger } from "../hostOperations.ts";
import type { PiRuntimeController } from "../piHost.ts";
import { MISSING_NATIVE_SESSION } from "../nativeSession.ts";
import type { ChannelSettings, ChannelStore } from "./channelStore.ts";
import type { ChannelPlatform } from "./types.ts";

/** One message as every connector hands it over, already stripped of the bot's own mention. */
export type InboundMessage = {
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  senderId: string;
  senderName?: string;
  text: string;
  /** Group messages are answered only when they address the bot. */
  mentioned: boolean;
  reply: Replier;
};

export type Replier = {
  send(text: string): Promise<void>;
  /** A message updated in place while the turn runs; absent where the platform cannot edit. */
  stream?(initial: string): Promise<ReplyStream>;
};

export type ReplyStream = { update(text: string): Promise<void>; finish(text: string): Promise<void> };

export type ChannelRuntime = Pick<PiRuntimeController, "runPrompt" | "configure" | "abort" | "resolveApproval" | "resolveUserInput">;

type Pending = {
  conversationId: string;
  runId: string;
  approval?: { toolCallId: string; name: string };
  input?: { requestId: string; questions: UserQuestion[] };
};

const HELP = [
  "直接发消息即可交给助手处理，回复会出现在这里，网页端的会话列表也能看到同一段对话。",
  "/new 开始新对话",
  "/stop 停止当前任务",
  "需要批准时回复「同意」「总是允许」或「拒绝」。",
].join("\n");
const STREAM_INTERVAL_MS = 1_000;

type ChannelBridgeOptions = {
  platform: ChannelPlatform;
  runtime: ChannelRuntime;
  store: ChannelStore;
  settings: () => ChannelSettings;
  defaultPermissionMode: PiPermissionMode;
  onDenied(sender: { id: string; name?: string }): void;
  log?: ReturnType<typeof runtimeLogger>;
};

/**
 * Turns IM messages into runs on the existing controller and the run's events back into chat
 * messages. Approvals and questions are answered by replying in the chat; nothing here keeps its
 * own transcript — the conversation store records the turn exactly as for the browser.
 * Command and approval wording follows dsh-im (MIT, github.com/xmanrui/dsh-im).
 */
export class ChannelBridge {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly options: ChannelBridgeOptions;

  constructor(options: ChannelBridgeOptions) {
    this.options = options;
  }

  /** Returns once the message is accepted; the turn itself keeps running in the background. */
  async handle(message: InboundMessage): Promise<void> {
    if (this.seen.has(message.messageId)) return;
    this.seen.add(message.messageId);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const text = message.text.trim();
    if (!text || (message.chatType === "group" && !message.mentioned)) return;
    const settings = this.options.settings();
    if (settings.access === "allowlist" && !settings.allowUsers.includes(message.senderId)) {
      this.options.onDenied({ id: message.senderId, name: message.senderName });
      if (message.chatType === "direct") {
        await message.reply.send(`你还没有使用权限。请在 RaytoneBot 设置 → IM 频道中允许这个用户 ID：\n${message.senderId}`);
      }
      return;
    }
    const chatKey = `${this.options.platform}:${message.chatType}:${message.chatId}`;
    const pending = this.pending.get(chatKey);
    const command = /^\/([a-z]+)(?:@\S+)?\s*$/i.exec(text)?.[1]?.toLowerCase();
    if (command === "help" || command === "start") return message.reply.send(HELP);
    if (command === "stop") {
      const stopped = pending ? await this.options.runtime.abort(pending.conversationId, pending.runId) : false;
      return message.reply.send(stopped ? "已停止当前任务。" : "当前没有正在运行的任务。");
    }
    if (command === "new") {
      if (pending) return message.reply.send("当前任务还在运行，先发送 /stop 停止，再开始新对话。");
      this.options.store.bindConversation(chatKey, newConversationId(chatKey));
      return message.reply.send("已开始新对话。");
    }
    if (pending?.approval) {
      const decision = approvalDecision(text);
      if (!decision) return message.reply.send(`「${pending.approval.name}」正在等待批准。回复「同意」「总是允许」或「拒绝」，或发送 /stop 停止。`);
      const resolved = this.options.runtime.resolveApproval(pending.approval.toolCallId, decision, pending.conversationId, pending.runId);
      pending.approval = undefined;
      return message.reply.send(!resolved ? "这个批准请求已经结束。" : decision === "no" ? "已拒绝。" : "已批准，继续执行。");
    }
    if (pending?.input) {
      const answers = questionAnswers(text, pending.input.questions);
      if (!answers) return message.reply.send("没能对应到选项。请回复选项编号或文字（多个问题时每行一个答案），或回复「跳过」。");
      try {
        const resolved = this.options.runtime.resolveUserInput(pending.conversationId, pending.input.requestId, answers.value);
        pending.input = undefined;
        if (!resolved) return message.reply.send("这个问题已经结束。");
      } catch (error) {
        return message.reply.send(`回答无效：${errorMessage(error)}`);
      }
      return;
    }
    if (pending) return message.reply.send("上一个任务还在运行。等它完成，或发送 /stop 停止。");
    void this.run(chatKey, text, message, settings).catch(() => {
      this.options.log?.("channel.run_failed", { platform: this.options.platform });
    });
  }

  private async run(chatKey: string, prompt: string, message: InboundMessage, settings: ChannelSettings) {
    let conversationId = this.options.store.conversationFor(chatKey);
    if (!conversationId) {
      conversationId = newConversationId(chatKey);
      this.options.store.bindConversation(chatKey, conversationId);
    }
    const runId = `im_${randomUUID()}`;
    const pending: Pending = { conversationId, runId };
    this.pending.set(chatKey, pending);
    const assistantTexts = new Set<string>();
    /** The approval event carries only the call id; the name comes with the call's start. */
    const toolNames = new Map<string, string>();
    let answer = "";
    let status = "";
    let failure = "";
    let cancelled = false;
    let stream: ReplyStream | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = Promise.resolve();
    const preview = () => `${answer || "思考中…"}${status ? `\n\n> ${status}` : ""}`;
    const scheduleFlush = () => {
      if (!stream || flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        const text = preview();
        flushing = flushing.then(() => stream?.update(text)).catch(() => undefined);
      }, STREAM_INTERVAL_MS);
    };
    const notify = (text: string) => void message.reply.send(text).catch(() => undefined);
    try {
      stream = message.reply.stream ? await message.reply.stream("思考中…").catch(() => undefined) : undefined;
      const model = settings.model;
      if (model) {
        await this.options.runtime.configure({ conversationId, providerDefinition: model.definition, provider: model.definition.id, model: model.model });
      }
      await this.options.runtime.runPrompt({
        conversationId,
        requestId: runId,
        prompt,
        provider: model?.definition.id,
        model: model?.model,
        permissionMode: this.options.defaultPermissionMode,
        agentPreset: settings.agentPreset,
      }, (event: AgentUXEvent) => {
        const payload = (event.payload ?? {}) as Record<string, any>;
        switch (event.type) {
          case "text.started":
            if (payload.role === "assistant") {
              assistantTexts.add(payload.textId);
              if (answer && !answer.endsWith("\n\n")) answer += "\n\n";
            }
            break;
          case "text.delta":
            if (assistantTexts.has(payload.textId) && typeof payload.delta === "string") {
              answer += payload.delta;
              status = "";
              scheduleFlush();
            }
            break;
          case "tool.call.started":
            toolNames.set(String(payload.toolCallId), String(payload.title ?? payload.name ?? "工具"));
            status = `正在使用 ${payload.title ?? payload.name ?? "工具"}…`;
            scheduleFlush();
            break;
          case "tool.call.awaiting_approval": {
            const name = String(payload.title ?? payload.name ?? toolNames.get(String(payload.toolCallId)) ?? "工具");
            pending.approval = { toolCallId: String(payload.toolCallId), name };
            notify(`需要你的批准：${name}\n${argsPreview(payload.argsPreview)}\n回复「同意」「总是允许」或「拒绝」。`);
            break;
          }
          case "tool.call.finished":
            if (pending.approval?.toolCallId === payload.toolCallId) pending.approval = undefined;
            break;
          case "run.awaiting_input":
            if (Array.isArray(payload.questions)) {
              pending.input = { requestId: String(payload.requestId), questions: payload.questions };
              notify(questionsText(payload.questions));
            }
            break;
          case "tool.call.progress":
            if (payload.inputRequestId && pending.input?.requestId === payload.inputRequestId) pending.input = undefined;
            break;
          case "run.error":
            failure = String(payload.userMessage ?? payload.message ?? "任务失败。");
            break;
          case "run.finished":
            cancelled = payload.status === "cancelled";
            break;
        }
      });
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      if (this.pending.get(chatKey) === pending) this.pending.delete(chatKey);
      clearTimeout(flushTimer);
    }
    await flushing;
    const envVar = settings.model?.definition.apiKeyEnvVar;
    // Chats cannot use a browser session key; say where the server expects it.
    if (failure && envVar && /api key/i.test(failure)) failure += `\nIM 对话使用服务器环境变量 ${envVar} 中的密钥。`;
    if (failure === MISSING_NATIVE_SESSION) failure += "\n发送 /new 开始新对话。";
    const final = [answer.trim(), cancelled ? "（已停止）" : "", failure ? `⚠️ ${failure}` : ""].filter(Boolean).join("\n\n") || "已完成。";
    if (stream) await stream.finish(final).catch(() => message.reply.send(final));
    else await message.reply.send(final);
  }
}

/** One conversation per chat until /new; the id stays within the store's allowed characters. */
function newConversationId(chatKey: string): string {
  const digest = createHash("sha256").update(chatKey).digest("hex").slice(0, 12);
  return `im-${chatKey.split(":")[0]}-${digest}-${Date.now().toString(36)}`;
}

export function approvalDecision(text: string): PiApprovalDecision | undefined {
  const value = text.trim().toLowerCase().replace(/[。.!！]+$/, "");
  if (["总是允许", "始终允许", "always"].includes(value)) return "always";
  if (["同意", "批准", "允许", "可以", "好", "yes", "y", "ok", "approve"].includes(value)) return "yes";
  if (["拒绝", "不同意", "不行", "取消", "no", "n", "deny", "reject"].includes(value)) return "no";
  return undefined;
}

/** Number or label per question, one line each; "跳过" skips the whole request. */
export function questionAnswers(text: string, questions: UserQuestion[]): { value: Record<string, string[]> | null } | undefined {
  if (["跳过", "skip"].includes(text.trim().toLowerCase())) return { value: null };
  const lines = questions.length === 1 ? [text.trim()] : text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== questions.length) return undefined;
  const value: Record<string, string[]> = {};
  for (const [index, question] of questions.entries()) {
    const parts = question.multiSelect ? lines[index].split(/[,，、\s]+/).filter(Boolean) : [lines[index]];
    const picked: string[] = [];
    for (const part of parts) {
      const number = /^\d+$/.test(part) ? Number(part) : NaN;
      const option = question.options[number - 1] ?? question.options.find((entry) => entry.label.toLowerCase() === part.toLowerCase());
      if (option) picked.push(option.label);
      else if (question.allowOther) picked.push(question.multiSelect ? part : lines[index]);
      else return undefined;
      if (!question.multiSelect) break;
    }
    value[question.id] = [...new Set(picked)];
  }
  return { value };
}

function questionsText(questions: UserQuestion[]): string {
  const body = questions.map((question, index) => [
    `${questions.length > 1 ? `${index + 1}. ` : ""}${question.question}${question.multiSelect ? "（可多选）" : ""}`,
    ...question.options.map((option, n) => `  ${n + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`),
  ].join("\n")).join("\n\n");
  return `${body}\n\n回复选项编号或文字${questions.length > 1 ? "，每个问题一行" : ""}；回复「跳过」不回答。`;
}

function argsPreview(args: unknown): string {
  if (args === undefined) return "";
  const text = typeof args === "string" ? args : JSON.stringify(args, null, 1);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** Splits at line breaks where possible, so each piece fits one platform message. */
export function splitText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const at = cut > limit / 2 ? cut : limit;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  pieces.push(rest);
  return pieces;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
