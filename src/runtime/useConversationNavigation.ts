import { useEffect, useRef, useState } from "react";
import { conversationHistoryGroup } from "./useSessionHistoryGroups.ts";
import type { SearchSession } from "./useConversationSearch.ts";

export type ConversationScope = "current" | "all" | "group";

export function scopedConversations(sessions: readonly SearchSession[], scope: ConversationScope, botId: string, botIds?: Record<string, string>) {
  return scope === "all" ? sessions : sessions.filter(session => conversationHistoryGroup(session, botIds) === (scope === "group" ? "group" : botId));
}

export function conversationToResume(sessions: readonly SearchSession[], botId: string, remembered?: string, botIds?: Record<string, string>) {
  const matching = sessions.filter(session => conversationHistoryGroup(session, botIds) === botId);
  return matching.find(session => session.id === remembered)?.id
    ?? [...matching].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id;
}

/** Navigation belongs to the shell so closing a drawer does not erase the search or last visit. */
export function useConversationNavigation(activeId: string, botId: string, group: boolean) {
  const lastVisited = useRef(new Map<string, string>());
  const [scope, setScope] = useState<ConversationScope>(group ? "group" : "current");
  const [query, setQuery] = useState("");
  const scrollTop = useRef(0);
  useEffect(() => { lastVisited.current.set(group ? "group" : botId, activeId); }, [activeId, botId, group]);
  return { scope, setScope, query, setQuery, scrollTop, lastVisited };
}
