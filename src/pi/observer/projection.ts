import { visibleConversationText } from "../conversationSearch.ts";
import type { StoredConversation } from "../conversationStore.ts";
import { publicProjection } from "./evidence.ts";
import type { ConversationProjection, PublicEvent, SourceIdentity } from "./types.ts";
/** Explicit public fields only: source tool arguments/results and native reasoning never enter queries. */
export function observerConversationProjection(saved: StoredConversation, source: SourceIdentity): ConversationProjection {
  const messages: PublicEvent[] = visibleConversationText(saved.events).map(message => ({ id: message.textId, messageId: message.textId, runId: message.runId, type: message.role, text: message.text, at: message.timestamp }));
  for (const [index, event] of saved.events.entries()) {
    if (event.visibility && event.visibility !== "public") continue;
    if (event.type === "run.finished" || event.type === "run.error") messages.push({ id: event.id ?? `event_${index}`, runId: event.runId, type: "terminal", status: event.type === "run.error" ? "error" : String(event.payload.status ?? "unknown"), at: event.ts });
    else if (event.type === "tool.call.error" && event.payload.code === "approval_denied") messages.push({ id: event.id ?? `event_${index}`, runId: event.runId, type: "approval", status: "denied", at: event.ts });
    else if (event.type === "tool.call.started" || event.type === "tool.call.finished") messages.push({ id: event.id ?? `event_${index}`, runId: event.runId, type: "tool", tool: typeof event.payload.toolName === "string" ? event.payload.toolName : undefined, status: event.type === "tool.call.started" ? "running" : String(event.payload.status ?? "unknown"), at: event.ts });
  }
  return publicProjection({ source, version: "", botId: saved.botId ?? saved.agentPreset, harness: saved.cliSession?.harness ?? "pi", createdAt: saved.createdAt, updatedAt: saved.updatedAt, events: messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) });
}
