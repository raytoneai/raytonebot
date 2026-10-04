import { useRef, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { ApprovalDecision } from "../components/agent-preview/ToolCallCard";

/** Tool ids are local to an engine run, so they cannot identify a dismissed request alone. */
export function approvalRequestKey(conversationId: string, toolCallId: string, events: readonly AgentUXEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "tool.call.awaiting_approval" && event.payload.toolCallId === toolCallId) return JSON.stringify([conversationId, event.id, toolCallId]);
  }
  return JSON.stringify([conversationId, null, toolCallId]);
}

/** Both existing approval surfaces use the same pending, failure and duplicate-click semantics. */
export function useApprovalSubmission(onConfirm?: (decision: ApprovalDecision) => void | Promise<void>) {
  const [status, setStatus] = useState<"idle" | "pending" | "failed">("idle");
  const sending = useRef(false);
  async function submit(decision: ApprovalDecision) {
    if (sending.current || !onConfirm) return;
    sending.current = true;
    setStatus("pending");
    try { await onConfirm(decision); setStatus("idle"); }
    catch { setStatus("failed"); }
    finally { sending.current = false; }
  }
  return { pending: status === "pending", failed: status === "failed", submit };
}
