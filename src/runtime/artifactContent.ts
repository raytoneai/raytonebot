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

export function artifactBody(artifact: { content?: string; data?: unknown; artifactKind?: string; uri?: string }): string | undefined {
  if (artifact.artifactKind === "file" && artifact.uri?.startsWith("file://")) return undefined;
  if (artifact.data !== undefined) return JSON.stringify(artifact.data, null, 2);
  return artifact.content;
}

/** File tabs follow the latest artifact at the exact registered path; other snapshots keep their identity. */
export function refreshArtifactItems(items: readonly OutputPanelItem[], timeline: readonly AgentUXTimelineItem[]): OutputPanelItem[] {
  const all = timeline.filter((item) => item.kind === "artifact");
  const artifacts = new Map(all.map((item) => [item.id, item]));
  const paths = new Map(all.filter((item) => item.uri?.startsWith("file://") && item.status === "success").map((item) => [item.uri!.slice(7), item]));
  return items.map((item) => {
    const artifact = (item.workspacePath ? paths.get(item.workspacePath) : undefined) ?? (item.artifactId ? artifacts.get(item.artifactId) : undefined);
    return artifact ? { ...item, artifactId: artifact.id,
      ...(artifact.id !== item.artifactId && item.downloadUrl ? { downloadUrl: `${item.downloadUrl.split("&revision=")[0]}&revision=${encodeURIComponent(artifact.id)}` } : {}), title: (artifact.title ?? item.title).split("/").pop()!, subtitle: artifact.title ?? item.subtitle, body: artifactBody(artifact) } : item;
  });
}

/** Replay wraps group artifact ids in [run, field, id]; filenames never determine ownership. */
export function artifactAuthor(id: string): string | undefined {
  return /(?:^|")(assistant|planner|builder|bot_[a-f0-9-]{36})~/.exec(id.replace(/^artifact:/, ""))?.[1];
}
