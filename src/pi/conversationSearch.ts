import type { AgentUXEvent } from "@agent-ux/protocol";

export type ConversationTextMatch = { textId: string; snippet: string; role: "user" | "assistant"; timestamp?: number };
export type SearchPosition = [number, string, string];
export const compareSearchPosition = (a: SearchPosition, b: SearchPosition) => b[0] - a[0]
  || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

export function conversationSearchPattern(query: string): RegExp | undefined {
  const literal = query.normalize("NFC").trim().replace(/\s+/gu, " ");
  return literal ? new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : undefined;
}

/** Search visible messages, never raw tool arguments, reasoning or native session data. */
export function matchConversationText(title: string, events: readonly AgentUXEvent[], query: string): { snippet?: string; textId?: string; matches?: ConversationTextMatch[] } | undefined {
  const pattern = conversationSearchPattern(query);
  if (!pattern) return {};
  const normalize = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ");
  const messages = new Map<string, Omit<ConversationTextMatch, "snippet"> & { chunks: string[] }>();
  for (const event of events) {
    const { textId, role, delta, inputSkipped } = event.payload;
    if (typeof textId !== "string") continue;
    const key = JSON.stringify([event.runId, textId]);
    if (event.type === "text.started" && (role === "user" || role === "assistant")) messages.set(key, {
      textId, role, timestamp: Number.isFinite(event.ts) ? event.ts : undefined, chunks: [],
    });
    if (event.type === "text.delta" && typeof delta === "string" && !inputSkipped) messages.get(key)?.chunks.push(delta);
  }
  const matches: ConversationTextMatch[] = [];
  for (const { chunks, ...message } of messages.values()) {
    const text = normalize(chunks.join("")), match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 45), end = Math.min(text.length, match.index + match[0].length + 90);
    matches.push({ ...message, snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` });
  }
  if (matches.length) return { textId: matches[0].textId, snippet: matches[0].snippet, matches };
  return pattern.test(normalize(title)) ? {} : undefined;
}
