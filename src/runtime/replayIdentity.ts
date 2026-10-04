import type { AgentUXEvent } from "@agent-ux/protocol";

function replayId(event: AgentUXEvent, field: "toolCallId" | "artifactId") {
  return JSON.stringify([event.runId ?? null, field, event.payload[field]]);
}

/** Native ids belong to one run; the renderer indexes the entire conversation. */
export function identityEventForReplay(event: AgentUXEvent): AgentUXEvent {
  const field = event.type.startsWith("tool.call.") ? "toolCallId" : event.type.startsWith("artifact.") ? "artifactId" : undefined;
  if (!field || typeof event.payload[field] !== "string") return event;
  return { ...event, payload: { ...event.payload, [field]: replayId(event, field) } } as AgentUXEvent;
}

/** Resolve only actual approval events, never trust a parsed display id as an engine id. */
export function approvalForReplay(toolId: string, events: readonly AgentUXEvent[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "tool.call.awaiting_approval" && replayId(event, "toolCallId") === toolId) {
      return { toolCallId: event.payload.toolCallId, runId: event.runId };
    }
  }
  throw new Error("This approval is no longer available.");
}
