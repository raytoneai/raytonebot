import type { AgentUXArtifactTimelineItem, AgentUXTimelineItem } from "@agent-ux/render-core";
import { isVersionedArtifactId } from "./artifactVersions.ts";

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
    // A saved version deliberately keeps its own identity. It shares the source path with
    // the live work file, so path-only de-duplication would make A disappear when B is
    // delivered later in the same conversation.
    const identity = item.id.startsWith("artifact:") ? item.id.slice("artifact:".length) : item.id;
    files.set(isVersionedArtifactId(identity) ? `version:${item.id}` : path, item);
  }
  return [...files.values()];
}
