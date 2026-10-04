import type { AgentUXEvent } from "@agent-ux/protocol";
import { piErrorTurnEvents } from "../pi/piErrorTurn.ts";

export type HistoryNotice = { message: string; prompt?: string; runId?: string };

/** Display-only: a failed history read must not change persisted events or the live-stream cursor. */
export function historyFeedbackEvents(events: readonly AgentUXEvent[], conversationId: string, feedback?: string | HistoryNotice): readonly AgentUXEvent[] {
  if (!feedback) return events;
  const input = typeof feedback === "string" ? { message: feedback } : feedback;
  const notice = piErrorTurnEvents({ ...input, code: "history_load_failed", runId: input.runId ?? `history_${conversationId}`, now: 0 });
  return [...events, ...notice.map((event, index) => ({ ...event, seq: events.length + index + 1 }))];
}
