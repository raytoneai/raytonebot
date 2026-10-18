import type { AgentUXArtifactTimelineItem, AgentUXTimelineItem } from "@agent-ux/render-core";

/** Deliverable files, not plans, directory listings or tool-result snapshots. */
export function workArtifacts(timeline: readonly AgentUXTimelineItem[]): AgentUXArtifactTimelineItem[] {
  const files = new Map<string, AgentUXArtifactTimelineItem>();
  for (const item of timeline) {
    if (item.kind !== "artifact" || item.status === "error" || item.status === "cancelled") continue;
    if (/(?:^|["~])plan_/.test(item.id)) continue;
    const path = item.uri?.startsWith("file://") ? item.uri.slice(7) : item.title ?? "";
    if (!/\.(html?|md|mdx|pdf|png|jpe?g|gif|webp|avif|svg|mp3|wav|m4a|aac|ogg|flac|mp4|webm|mov|m4v|docx?|xlsx?|pptx?|csv|txt|form\.json)$/i.test(path)) continue;
    // A diff without a saved file is an execution detail, not a previewable deliverable.
    if (item.artifactKind === "diff" && !item.uri?.startsWith("file://")) continue;
    files.set(path, item);
  }
  return [...files.values()];
}
