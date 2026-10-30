import type { AgentUXEvent } from "@agent-ux/protocol";

export type ConversationActivity = {
  runId: string; eventId: string; at: number;
  status: "success" | "error" | "cancelled";
  textId?: string;
};

/** A result belongs to a completed turn, never to a later turn still running. */
export function conversationActivity(events: readonly AgentUXEvent[]): ConversationActivity | undefined {
  let terminal: AgentUXEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "run.started") break;
    if (event.type === "run.finished" || event.type === "run.error") { terminal = event; break; }
  }
  if (!terminal?.runId) return;
  const text = events.find(event => event.runId === terminal.runId && event.type === "text.started" && event.payload.role === "user");
  const status = terminal.type === "run.error" ? "error" : terminal.payload.status ?? "success";
  return { runId: terminal.runId, eventId: terminal.id ?? `${terminal.runId}:${terminal.type}:${terminal.seq ?? 0}`, at: terminal.ts ?? 0,
    status: status === "success" ? "success" : status === "cancelled" ? "cancelled" : "error",
    ...(typeof text?.payload.textId === "string" ? { textId: text.payload.textId } : {}) };
}

export type AttentionStatus = "needs-you" | "error" | "missed" | "new-result" | "running";
export const attentionLabel = (status: AttentionStatus, zh: boolean) => ({
  "needs-you": zh ? "需要你" : "Needs you", error: zh ? "失败" : "Failed", missed: zh ? "未运行" : "Not run",
  "new-result": zh ? "新结果" : "New result", running: zh ? "运行中" : "Running",
})[status];
export const activityKey = (activity: ConversationActivity) => JSON.stringify([activity.runId, activity.eventId, activity.at]);
export function conversationAttention(input: { activity?: ConversationActivity; running?: boolean; awaitingUser?: boolean }, seen?: string | readonly string[]): AttentionStatus | undefined {
  if (input.awaitingUser) return "needs-you";
  if (input.running) return "running";
  const activity = input.activity;
  if (!activity || (typeof seen === "string" ? seen === activityKey(activity) : seen?.includes(activityKey(activity))) || activity.status === "cancelled") return;
  return activity.status === "success" ? "new-result" : "error";
}
