import type { AgentUXArtifactTimelineItem } from "@agent-ux/render-core";
import { ChevronDown, FileAudio2, FileVideo2, Globe2, ImageIcon } from "lucide-react";

import type { UiCopy } from "../../../i18n/uiCopy";
import type { AgentFrontendProject } from "../../../schema/agentuxConfig";
import type { OutputPanelOpenRequest } from "../OutputFrame";
import { artifactBody } from "../../../runtime/artifactContent";

type ArtifactMediaKind = "image" | "audio" | "video";

export function ArtifactLaunchCard({
  project,
  item,
  copy,
  onOpenArtifact,
}: {
  project: AgentFrontendProject;
  item: AgentUXArtifactTimelineItem;
  copy: UiCopy;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
}) {
  const mediaKind = artifactMediaKind(item);
  const mediaStyle = mediaKind ? mediaGenerationStyle(project, mediaKind) : undefined;
  const launchTitle = artifactLaunchTitle(item);
  const Icon = mediaKind === "image" ? ImageIcon : mediaKind === "audio" ? FileAudio2 : mediaKind === "video" ? FileVideo2 : Globe2;
  return (
    <article
      className={`artifact-inline artifact-launch-card${mediaKind ? " media-generation-inline" : ""}`}
      data-status={item.status}
      data-media-kind={mediaKind ?? "website"}
      data-media-style={mediaStyle}
    >
      <span className="artifact-inline-icon" aria-hidden="true"><Icon size={24} /></span>
      <span className="artifact-inline-body">
        <strong>{launchTitle}</strong>
        <span className="artifact-launch-kind">{artifactLaunchKind(item, copy)}</span>
      </span>
      <span className="artifact-launch-actions">
        <button
          type="button"
          className="artifact-action-open"
          onClick={() => onOpenArtifact?.(artifactLaunchOpenRequest(item, copy, project))}
        >
          <span>{copy.chat.artifactLaunch.openWith}</span>
          <ChevronDown size={20} aria-hidden="true" />
        </button>
      </span>
    </article>
  );
}

/**
 * What the artifact actually is, rather than what the demo used to show.
 *
 * Both this and `artifactLaunchOpenRequest` used to hardcode "Agent Component Composer" and a
 * canned HTML snippet for anything that was not an image, audio or video — so a real run that
 * wrote a 10KB HTML deck displayed a fixture page instead of the file, and a `SearchInput.tsx`
 * was labelled a website. The real title and the real content are what the file is.
 */
function artifactLaunchTitle(item: AgentUXArtifactTimelineItem): string {
  const title = item.title ?? item.id;
  // Basenamed, as the media branch already does: a path is not a name.
  return title.split("/").filter(Boolean).pop() ?? title;
}

function artifactIsWebsite(item: AgentUXArtifactTimelineItem): boolean {
  const title = (item.title ?? item.id).toLowerCase();
  const mimeType = String((item as AgentUXArtifactTimelineItem & { mimeType?: string }).mimeType ?? "").toLowerCase();
  return /\.(html?|xhtml)$/.test(title) || mimeType.includes("html");
}

function artifactLaunchKind(item: AgentUXArtifactTimelineItem, copy: UiCopy): string {
  const kind = artifactMediaKind(item);
  if (kind === "image") return copy.chat.artifactLaunch.kindImage;
  if (kind === "audio") return copy.chat.artifactLaunch.kindAudio;
  if (kind === "video") return copy.chat.artifactLaunch.kindVideo;
  // Only an actual page is a website. Calling every other artifact one is how a `.tsx` file
  // ended up labelled 网站.
  return artifactIsWebsite(item) ? copy.chat.artifactLaunch.kindWebsite : copy.chat.artifactLaunch.kindFile;
}

function artifactLaunchOpenRequest(item: AgentUXArtifactTimelineItem, copy: UiCopy, project: AgentFrontendProject): OutputPanelOpenRequest {
  const originalTitle = item.title ?? item.id;
  const workspacePath = item.uri?.startsWith("file://") ? item.uri.slice(7) : undefined;
  const mediaKind = artifactMediaKind(item);
  if (mediaKind) {
    const title = originalTitle.split("/").filter(Boolean).pop() ?? originalTitle;
    return {
      id: `artifact:${item.id}`,
      artifactId: item.id,
      kind: "file",
      title,
      subtitle: originalTitle,
      workspacePath,
      language: mediaKind,
      body: artifactBody(item),
      mediaSrc: item.uri,
      mediaStyle: mediaGenerationStyle(project, mediaKind),
    };
  }
  const website = artifactIsWebsite(item);
  return {
    id: `artifact:${item.id}`,
    artifactId: item.id,
    kind: item.artifactKind === "diff" ? "review" : "file",
    title: artifactLaunchTitle(item),
    subtitle: originalTitle,
    workspacePath,
    // Let the output panel decide by extension when the artifact does not say; forcing "html"
    // made every artifact render through the HTML preview path.
    language: item.data !== undefined ? "json" : website ? "html" : undefined,
    // The real content. Falling back to the demo page here is what hid a real deck behind a
    // fixture; with no content the panel shows its own empty state, which is the truth.
    body: artifactBody(item),
  };
}

function artifactMediaKind(item: AgentUXArtifactTimelineItem): ArtifactMediaKind | undefined {
  const title = (item.title ?? item.id).toLowerCase();
  const mimeType = String((item as AgentUXArtifactTimelineItem & { mimeType?: string }).mimeType ?? "").toLowerCase();
  const kind = String(item.artifactKind ?? "").toLowerCase();
  if (kind.includes("image") || mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(title)) {
    return "image";
  }
  if (kind.includes("audio") || mimeType.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(title)) {
    return "audio";
  }
  if (kind.includes("video") || mimeType.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/.test(title)) {
    return "video";
  }
  return undefined;
}

function mediaGenerationStyle(project: AgentFrontendProject, kind: ArtifactMediaKind): string {
  if (kind === "image") return project.mediaGeneration.imageStyle;
  if (kind === "audio") return project.mediaGeneration.audioStyle;
  return project.mediaGeneration.videoStyle;
}
