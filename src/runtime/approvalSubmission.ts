import { useEffect, useRef, useState } from "react";
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

/** Keep the selected decision visible until the host confirms its delivery. */
export function useApprovalSubmission(onConfirm?: (decision: ApprovalDecision, signal?: AbortSignal) => void | Promise<void>) {
  const [decision, setDecision] = useState<ApprovalDecision>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(decision: ApprovalDecision) {
    if (request.current || !onConfirm) return;
    const controller = new AbortController();
    request.current = controller;
    setDecision(decision);
    try { await onConfirm(decision, controller.signal); }
    catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) console.warn("Approval confirmation interrupted", error);
    } finally {
      if (!controller.signal.aborted) setDecision(undefined);
      if (request.current === controller) request.current = undefined;
    }
  }
  return { pending: decision !== undefined, decision, submit };
}
