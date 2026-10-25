import type { AgentUXEvent } from "@agent-ux/protocol";

export type ConversationTextMatch = { textId: string; snippet: string; role: "user" | "assistant"; timestamp?: number };
export type SearchPosition = [number, string, string];
export const compareSearchPosition = (a: SearchPosition, b: SearchPosition) => b[0] - a[0]
  || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

export function conversationSearchPattern(query: string): RegExp | undefined {
  const literal = query.normalize("NFC").trim().replace(/\s+/gu, " ");
  return literal ? new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : undefined;
}

export type ConversationText = Omit<ConversationTextMatch, "snippet"> & { runId?: string; text: string };

/** Only public user/assistant text, including buffered streaming deltas. */
export function visibleConversationText(events: readonly AgentUXEvent[]): ConversationText[] {
  const messages = new Map<string, Omit<ConversationText, "text"> & { chunks: string[] }>();
  for (const event of events) {
    if (event.visibility && event.visibility !== "public") continue;
    const { textId, role, delta, inputSkipped } = event.payload;
    if (typeof textId !== "string" || !textId) continue;
    const key = JSON.stringify([event.runId, textId]);
    if (event.type === "text.started" && (role === "user" || role === "assistant") && !messages.has(key)) messages.set(key, {
      textId, role, runId: event.runId, timestamp: Number.isFinite(event.ts) ? event.ts : undefined, chunks: [],
    });
    if (event.type === "text.delta" && typeof delta === "string" && !inputSkipped) messages.get(key)?.chunks.push(delta);
  }
  return [...messages.values()].filter(message => message.chunks.length > 0)
    .map(({ chunks, ...message }) => ({ ...message, text: chunks.join("") }));
}

/** Search visible messages, never raw tool arguments, reasoning or native session data. */
export function matchConversationText(title: string, events: readonly AgentUXEvent[], query: string): { snippet?: string; textId?: string; matches?: ConversationTextMatch[] } | undefined {
  const pattern = conversationSearchPattern(query);
  if (!pattern) return {};
  const normalize = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ");
  const matches: ConversationTextMatch[] = [];
  for (const { text: content, runId: _runId, ...message } of visibleConversationText(events)) {
    const text = normalize(content), match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 45), end = Math.min(text.length, match.index + match[0].length + 90);
    matches.push({ ...message, snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` });
  }
  if (matches.length) return { textId: matches[0].textId, snippet: matches[0].snippet, matches };
  return pattern.test(normalize(title)) ? {} : undefined;
}
