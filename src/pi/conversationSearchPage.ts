import type { ConversationSummary } from "./conversationStore.ts";
import { compareSearchPosition as compare, type ConversationTextMatch, type SearchPosition as Position } from "./conversationSearch.ts";

export class SearchPageError extends Error { readonly status = 400; }

/** A seek cursor tolerates deletion/newer inserts; it is a position, not a snapshot or an offset. */
export function conversationSearchPage<T extends ConversationSummary>(conversations: T[], query: string, limit: number, cursor?: string) {
  if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new SearchPageError("Search page size must be between 1 and 100, with a query.");
  let after: Position | undefined;
  if (cursor) {
    try {
      if (cursor.length > 4096) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== query || !Number.isFinite(value[1])
        || typeof value[2] !== "string" || typeof value[3] !== "string") throw new Error();
      after = value.slice(1) as Position;
    } catch { throw new SearchPageError("Search cursor is invalid. Start a new search."); }
  }
  // ponytail: scan existing matches; an index can replace this when measured disk/CPU cost requires it.
  const rows = conversations.flatMap<{ conversation: T; match?: ConversationTextMatch; position: Position }>(conversation => conversation.matches?.length
    ? conversation.matches.map(match => ({ conversation, match, position: [match.timestamp ?? conversation.createdAt, conversation.id, match.textId] as Position }))
    : [{ conversation, match: undefined, position: [conversation.createdAt, conversation.id, ""] as Position }])
    .sort((a, b) => compare(a.position, b.position)).filter(row => !after || compare(row.position, after) > 0);
  const page = rows.slice(0, limit), grouped = new Map<string, T>();
  for (const { conversation, match } of page) {
    let summary = grouped.get(conversation.id);
    if (!summary) {
      const { matches: _matches, snippet: _snippet, textId: _textId, ...metadata } = conversation;
      summary = { ...metadata, ...(match ? { matches: [], snippet: match.snippet, textId: match.textId } : {}) } as T;
      grouped.set(summary.id, summary);
    }
    if (match) summary.matches!.push(match);
  }
  return { conversations: [...grouped.values()], nextCursor: rows.length > limit
    ? Buffer.from(JSON.stringify([query, ...page.at(-1)!.position])).toString("base64url") : undefined };
}
