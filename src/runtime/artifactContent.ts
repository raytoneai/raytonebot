import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem.ts";

/** Keep structured snapshots out of the vendor renderer's string-delta path. */
export function artifactEventForReplay(event: AgentUXEvent): AgentUXEvent {
  if (event.type !== "artifact.delta") return event;
  const payload = event.payload as Record<string, unknown>;
  if (payload.format !== "json" || payload.delta === undefined) return event;
  const { delta, ...rest } = payload;
  return { ...event, payload: { ...rest, data: delta } } as AgentUXEvent;
}

export function artifactBody(artifact: { content?: string; data?: unknown }): string | undefined {
  if (artifact.data !== undefined) return JSON.stringify(artifact.data, null, 2);
  return artifact.content;
}

/** Open tabs follow their own artifact, not the newest artifact or a matching filename. */
export function refreshArtifactItems(items: readonly OutputPanelItem[], timeline: readonly AgentUXTimelineItem[]): OutputPanelItem[] {
  const artifacts = new Map(timeline.filter((item) => item.kind === "artifact").map((item) => [item.id, item]));
  return items.map((item) => {
    const artifact = item.artifactId ? artifacts.get(item.artifactId) : undefined;
    return artifact ? { ...item, title: (artifact.title ?? item.title).split("/").pop()!, subtitle: artifact.title ?? item.subtitle, body: artifactBody(artifact) } : item;
  });
}
