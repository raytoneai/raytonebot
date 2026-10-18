import { useEffect, useState } from "react";
import { isAgentPresetId, type AgentPresetId } from "../pi/harnessCatalog.ts";
import type { SearchSession } from "./useConversationSearch.ts";

export type HistoryGroupId = AgentPresetId | "group" | "other";

export function conversationHistoryGroup(session: { id: string; agentPreset?: string }): HistoryGroupId {
  if (session.id.startsWith("group_")) return "group";
  return isAgentPresetId(session.agentPreset) ? session.agentPreset : "other";
}

export function groupSessionHistory(sessions: readonly SearchSession[]) {
  const order: HistoryGroupId[] = ["assistant", "planner", "builder", "group", "other"];
  const groups = new Map(order.map(id => [id, [] as SearchSession[]]));
  for (const session of sessions) groups.get(conversationHistoryGroup(session))!.push(session);
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
