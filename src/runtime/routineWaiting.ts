import type { AgentUXEvent } from "@agent-ux/protocol";
import type { RoutineWaiting } from "../pi/routineTypes.ts";

/** Current unresolved waits in one exact run; legacy synthetic event.ts is never a duration. */
export function routineWaiting(events: readonly AgentUXEvent[], runId: string): RoutineWaiting | undefined {
  type Wait = { reason: RoutineWaiting["reasons"][number]; since?: number; toolCallId?: string };
  const pending = new Map<string, Wait>();
  for (const event of events) {
    if (event.runId !== runId) continue;
    const payload = event.payload;
    if (event.type === "run.finished" || event.type === "run.error") return;
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    let key: string | undefined, reason: Wait["reason"] | undefined;
    if (event.type === "tool.call.awaiting_approval" && toolCallId) {
      key = `approval:${toolCallId}`; reason = "approval";
    } else if (event.type === "run.awaiting_input" && typeof payload.requestId === "string" && payload.requestId) {
      reason = payload.vaultRequest ? "vault" : payload.channelSetup ? "channel_setup" : "question";
      key = `input:${payload.requestId}`;
    }
    if (key && reason && !pending.has(key)) {
      const since = typeof payload.waitObservedAt === "number" && Number.isFinite(payload.waitObservedAt) && payload.waitObservedAt >= 0
        ? payload.waitObservedAt : undefined;
      pending.set(key, { reason, since, toolCallId });
    }
    if (event.type === "tool.call.progress" && typeof payload.inputRequestId === "string") pending.delete(`input:${payload.inputRequestId}`);
    if (toolCallId && ["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished"].includes(event.type)) {
      pending.delete(`approval:${toolCallId}`);
      // Rejected/cancelled input tools can finish without an ordinary answer receipt.
      if (event.type !== "tool.call.running") for (const [id, wait] of pending) if (wait.toolCallId === toolCallId) pending.delete(id);
    }
  }
  if (!pending.size) return;
  const waits = [...pending.values()];
  const reasons = (["approval", "question", "vault", "channel_setup"] as const).filter(reason => waits.some(wait => wait.reason === reason));
  return { reasons, count: waits.length, ...(waits.every(wait => wait.since !== undefined) ? { since: Math.min(...waits.map(wait => wait.since!)) } : {}) };
}
