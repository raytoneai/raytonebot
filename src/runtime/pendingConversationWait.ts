import type { AgentUXEvent } from "@agent-ux/protocol";

const WAIT_SEPARATOR = "\u0000";

/**
 * The browser can receive a transcript in pieces (a stored snapshot followed by a live
 * stream). Keep one key per outstanding user decision so settling one of several approvals does
 * not hide the others. The run id is part of the key because tool/request ids are only unique
 * inside a turn.
 */
export type PendingConversationWaits = Set<string>;

function waitKey(runId: string, kind: "approval" | "input", id: string): string {
  return `${runId}${WAIT_SEPARATOR}${kind}${WAIT_SEPARATOR}${id}`;
}

function payloadOf(event: AgentUXEvent): Record<string, unknown> {
  return (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function removeRun(waits: PendingConversationWaits, runId?: string) {
  if (!runId) {
    waits.clear();
    return;
  }
  const prefix = `${runId}${WAIT_SEPARATOR}`;
  for (const key of waits) if (key.startsWith(prefix)) waits.delete(key);
}

function removeTool(waits: PendingConversationWaits, runId: string | undefined, toolCallId: string | undefined) {
  if (!toolCallId) return;
  const prefix = `${runId ?? ""}${WAIT_SEPARATOR}approval${WAIT_SEPARATOR}${toolCallId}`;
  for (const key of waits) if (key === prefix || (!runId && key.endsWith(`${WAIT_SEPARATOR}approval${WAIT_SEPARATOR}${toolCallId}`))) waits.delete(key);
}

function removeInput(waits: PendingConversationWaits, runId: string | undefined, requestId: string | undefined) {
  if (!requestId) return;
  const prefix = `${WAIT_SEPARATOR}input${WAIT_SEPARATOR}${requestId}`;
  for (const key of waits) {
    if (key === `${runId ?? ""}${prefix}` || (!runId && key.endsWith(prefix))) waits.delete(key);
  }
}

/** Apply one event without rescanning the conversation transcript. */
export function applyPendingConversationWait(waits: PendingConversationWaits, event: AgentUXEvent): void {
  const payload = payloadOf(event);
  const runId = stringValue(event.runId);

  if (event.type === "run.started") {
    // A conversation has one active turn. Drop a stale wait before recording the new turn.
    waits.clear();
    return;
  }

  if (event.type === "run.finished" || event.type === "run.error") {
    removeRun(waits, runId);
    return;
  }

  if (event.type === "tool.call.awaiting_approval") {
    const toolCallId = stringValue(payload.toolCallId);
    if (toolCallId) waits.add(waitKey(runId ?? "", "approval", toolCallId));
    return;
  }

  if (event.type === "run.awaiting_input") {
    const requestId = stringValue(payload.requestId);
    if (requestId) waits.add(waitKey(runId ?? "", "input", requestId));
    return;
  }

  if (["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished"].includes(event.type)) {
    removeTool(waits, runId, stringValue(payload.toolCallId));
  }

  // The adapter normalizes question, vault and channel answers to tool.call.progress.
  if (event.type === "tool.call.progress") removeInput(waits, runId, stringValue(payload.inputRequestId));
}

export function pendingConversationWaits(events: readonly AgentUXEvent[]): PendingConversationWaits {
  const waits: PendingConversationWaits = new Set();
  for (const event of events) applyPendingConversationWait(waits, event);
  return waits;
}
