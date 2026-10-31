import { looksLikeUnifiedDiff } from "../../../runtime/unifiedDiff";
import { renderDiffPreview } from "./diffPreview";
import type { ReactNode } from "react";

import type { OutputFrameCopy } from "./types";
import type { OutputPanelItem } from "./panelItem";
import type { OpenedOutputRenderKind } from "./renderKind";
import { AudioOutputPreview, ImageOutputPreview, VideoOutputPreview } from "./mediaPreviews";
import { renderMarkdownPreview as renderMarkdown } from "./markdown/renderMarkdown";
import { HtmlOutputPreview } from "./HtmlOutputPreview";

// Re-exported for the artifact renderer branch in OutputContent, which shares
// the same markdown pipeline as opened .md tabs.
export { renderMarkdownPreview } from "./markdown/renderMarkdown";

export function renderOpenedOutputBody(item: OutputPanelItem, kind: OpenedOutputRenderKind, language: string, copy: OutputFrameCopy, onMediaError?: () => void): ReactNode {
  if (kind === "pdf") {
    if (!item.mediaSrc) return <div className="empty-state">{copy.artifactMetadataEmpty}</div>;
    if (!navigator.pdfViewerEnabled) return <p role="status">{copy.pdfUnsupported}</p>;
    return <div className="pdf-output-preview"><p>{copy.pdfDownloadHint}</p><iframe src={item.mediaSrc} title={item.title} referrerPolicy="no-referrer" onError={onMediaError} /></div>;
  }
  if (kind === "image" || kind === "audio" || kind === "video") {
    if (!item.mediaSrc) return <div className="empty-state">{copy.artifactMetadataEmpty}</div>;
    if (kind === "image") return <ImageOutputPreview item={item} onError={onMediaError} />;
    if (kind === "audio") return <AudioOutputPreview item={item} onError={onMediaError} />;
    return <VideoOutputPreview item={item} onError={onMediaError} />;
  }
  // Empty bodies show an empty state; never synthesize preview content.
  if (item.body === undefined || item.body.trim() === "") {
    return <div className="empty-state">{copy.emptyNoArtifact}</div>;
  }
  const body = item.body;
  // An HTML preview requires markup in the body; other content shows as source.
  if (kind === "html" && looksLikeHtmlDocument(body)) {
    return <HtmlOutputPreview title={item.title} body={body} loadingLabel={copy.loadingFiles} failedLabel={copy.previewFailed} />;
  }
  if (kind === "markdown") {
    return <div className="markdown-preview">{renderMarkdown(body, copy)}</div>;
  }
  if (kind === "data") {
    return <pre data-language="json">{normalizeJsonPreview(body)}</pre>;
  }
  if (kind === "diff" || kind === "code" && looksLikeUnifiedDiff(body)) return renderDiffPreview(body);
  return <pre data-language={language}>{body}</pre>;
}

/** Full HTML documents and fragments can both be previewed. */
function looksLikeHtmlDocument(body: string): boolean {
  return /<!doctype|<html|<body|<[a-z][a-z0-9-]*[\s>/]/i.test(body.trim());
}

function normalizeJsonPreview(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
