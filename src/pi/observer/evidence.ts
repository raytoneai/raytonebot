import { createHash } from "node:crypto";
import { ObserverError, type ConversationProjection, type PublicEvent, type SourceIdentity } from "./types.ts";
export const sourceKey = (source: SourceIdentity) => `${source.instanceId}:${source.conversationId}:${source.generation}`;
export const evidenceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const suspect = /(?:\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\b(?:ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret|密码|密钥)\s*["']?\s*[:：=]\s*["']?[^\s"'{};,]{6,})/i;
export function safeText(value: string, max = 32768): string {
  if (typeof value !== "string") throw new ObserverError("observer_text_invalid");
  if (Buffer.byteLength(value) > max) throw new ObserverError("observer_read_limit", 413);
  if (value.includes("\0") || suspect.test(value)) throw new ObserverError("observer_suspected_secret", 403);
  return value;
}
/** Accept only the public projection contract, never raw session or native reasoning objects. */
export function publicProjection(value: ConversationProjection): ConversationProjection {
  const events: PublicEvent[] = value.events.filter(event => ["user", "assistant", "tool", "approval", "terminal"].includes(event.type)).map(event => ({
    id: String(event.id), type: event.type, ...(event.runId ? { runId: String(event.runId) } : {}), ...(event.messageId ? { messageId: String(event.messageId) } : {}),
    ...(event.at !== undefined ? { at: event.at } : {}),
    ...(["user", "assistant"].includes(event.type) && event.text ? { text: safeText(event.text, 256 * 1024) } : {}),
    ...(event.tool ? { tool: String(event.tool).slice(0, 100) } : {}), ...(event.status ? { status: String(event.status).slice(0, 100) } : {}),
  }));
  const result = { source: structuredClone(value.source), botId: value.botId, harness: value.harness, createdAt: value.createdAt, updatedAt: value.updatedAt, events };
  return { ...result, version: evidenceHash(result) };
}

export const cleanObserverText = safeText;
