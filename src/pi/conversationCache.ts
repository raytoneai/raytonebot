import type { ConversationSummary, StoredConversation } from "./conversationStore.ts";

/** Metadata stays available without retaining every transcript. Buffered events may not be evicted. */
export function createConversationCache() {
  const clean = new Map<string, StoredConversation>();
  const pending = new Map<string, StoredConversation>();
  const summaries = new Map<string, ConversationSummary>();
  return {
    get(id: string) {
      const value = pending.get(id) ?? clean.get(id);
      if (clean.has(id) && value) { clean.delete(id); clean.set(id, value); }
      return value;
    },
    summary: (id: string) => summaries.get(id),
    set(value: StoredConversation, buffered = false) {
      const { events, cliSession: _cli, piSessionId: _pi, turns: _turns, branch: _branch, ...summary } = value;
      summaries.set(value.id, { ...summary, eventCount: events.length });
      clean.delete(value.id);
      pending.delete(value.id);
      (buffered ? pending : clean).set(value.id, value);
      // ponytail: bound by count; add a byte budget if individual saved transcripts become too large.
      while (clean.size > 12) clean.delete(clean.keys().next().value!);
    },
    delete(id: string) {
      clean.delete(id);
      pending.delete(id);
      summaries.delete(id);
    },
  };
}
