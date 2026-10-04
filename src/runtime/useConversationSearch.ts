import { useEffect, useRef, useState } from "react";
import { compareSearchPosition, conversationSearchPattern, type ConversationTextMatch } from "../pi/conversationSearch.ts";

export type SearchSession = { id: string; title: string; createdAt?: number; matches?: ConversationTextMatch[] } & Partial<ConversationTextMatch>;
export type SearchPage = { conversations: SearchSession[]; unreadable: string[]; nextCursor?: string };
export type ConversationSearch = (query: string, signal: AbortSignal, cursor?: string) => Promise<SearchPage>;
export const searchResultKey = (session: SearchSession) => JSON.stringify([session.id, session.textId ?? ""]);

/** Conversation identity owns history; message identity owns a selectable search result. */
export function conversationSearchResults(local: readonly SearchSession[], remote: readonly SearchSession[] = []): SearchSession[] {
  const matchedIds = new Set(remote.map(session => session.id));
  const expanded = remote.flatMap(({ matches, ...session }) => matches?.length
    ? matches.map(match => ({ ...session, ...match, createdAt: match.timestamp ?? session.createdAt })) : [session]);
  const rows = [...local.filter(session => !matchedIds.has(session.id)), ...expanded];
  return [...new Map(rows.map(row => [searchResultKey(row), row])).values()]
    .sort((a, b) => compareSearchPosition([a.createdAt ?? 0, a.id, a.textId ?? ""], [b.createdAt ?? 0, b.id, b.textId ?? ""]));
}

type Result = SearchPage & { query: string; status: "ready" | "partial" | "failed"; more?: "loading" | "failed" };
export function useConversationSearch(query: string, open: boolean, sessions: readonly SearchSession[], search?: ConversationSearch) {
  const value = query.trim();
  const [result, setResult] = useState<Result>();
  const request = useRef<{ controller: AbortController; pending?: Promise<boolean> }>(undefined);
  useEffect(() => {
    setResult(undefined);
    if (!open || !value || !search) return;
    const controller = new AbortController();
    request.current = { controller };
    const timer = setTimeout(() => {
      void search(value, controller.signal).then(page => {
        if (!controller.signal.aborted) setResult({ ...page, query: value, status: page.unreadable.length ? "partial" : "ready" });
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ query: value, conversations: [], unreadable: [], status: "failed" });
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [value, open, search]);
  const pattern = conversationSearchPattern(value);
  const local = pattern ? sessions.filter(session => pattern.test(session.title.normalize("NFC").replace(/\s+/gu, " "))) : sessions;
  const current = open && value && result?.query === value ? result : undefined;
  const loadMore = (): Promise<boolean> => {
    const active = request.current, cursor = current?.nextCursor;
    if (!active || active.controller.signal.aborted || !cursor || !search) return Promise.resolve(false);
    if (active.pending) return active.pending;
    setResult(previous => previous && { ...previous, more: "loading" });
    active.pending = search(value, active.controller.signal, cursor).then(page => {
      if (active.controller.signal.aborted) return false;
      if (page.nextCursor === cursor) throw new Error("Search page did not advance");
      setResult(previous => previous && { ...previous, nextCursor: page.nextCursor, more: undefined,
        conversations: [...previous.conversations, ...page.conversations],
        status: previous.status === "partial" || page.unreadable.length ? "partial" : "ready" });
      return true;
    }).catch(() => {
      if (!active.controller.signal.aborted) setResult(previous => previous && { ...previous, more: "failed" });
      return false;
    }).finally(() => { active.pending = undefined; });
    return active.pending;
  };
  return { sessions: conversationSearchResults(local, current?.conversations),
    status: open && value && search ? current?.status ?? "loading" : "ready",
    hasMore: Boolean(current?.nextCursor), more: current?.more, loadMore };
}
