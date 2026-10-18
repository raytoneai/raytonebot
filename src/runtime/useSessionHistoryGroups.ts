import { useEffect, useState } from "react";
import { isAgentPresetId, type AgentPresetId } from "../pi/harnessCatalog.ts";
import type { SearchSession } from "./useConversationSearch.ts";

export type HistoryGroupId = AgentPresetId | "group" | "other" | `bot_${string}`;

export function conversationHistoryGroup(session: { id: string; agentPreset?: string }, botIds?: Record<string, string>): HistoryGroupId {
  if (session.id.startsWith("group_")) return "group";
  const botId = botIds?.[session.id];
  if (botId && (isAgentPresetId(botId) || botId.startsWith("bot_"))) return botId as HistoryGroupId;
  return isAgentPresetId(session.agentPreset) ? session.agentPreset : "other";
}

export function groupSessionHistory(sessions: readonly SearchSession[], botIds?: Record<string, string>) {
  const order: HistoryGroupId[] = ["assistant", "planner", "builder", "group", "other"];
  const groups = new Map(order.map(id => [id, [] as SearchSession[]]));
  for (const session of sessions) {
    const id = conversationHistoryGroup(session, botIds);
    if (!groups.has(id)) { groups.set(id, []); order.splice(order.length - 2, 0, id); }
    groups.get(id)!.push(session);
  }
  return order.flatMap(id => {
    const items = groups.get(id)!;
    return items.length ? [{ id, items }] : [];
  });
}

/** Kept by the host so panel/drawer remounts preserve the user's open groups. */
export function useSessionHistoryGroups(activeId: string, activeGroup: HistoryGroupId) {
  const [expanded, setExpanded] = useState<Partial<Record<HistoryGroupId, boolean>>>(() => ({ [activeGroup]: true }));
  useEffect(() => {
    setExpanded(previous => previous[activeGroup] ? previous : { ...previous, [activeGroup]: true });
  }, [activeId, activeGroup]);
  return { expanded, toggle: (id: HistoryGroupId) => setExpanded(previous => ({ ...previous, [id]: !previous[id] })) };
}
