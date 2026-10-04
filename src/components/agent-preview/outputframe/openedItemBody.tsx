import type { ReactNode } from "react";

import type { OutputFrameCopy } from "./types";
import type { OutputPanelItem } from "./panelItem";
import type { OpenedOutputRenderKind } from "./renderKind";
import { AudioOutputPreview, ImageOutputPreview, VideoOutputPreview } from "./mediaPreviews";
import { renderMarkdownPreview as renderMarkdown } from "./markdown/renderMarkdown";
import { htmlPreviewDocument } from "./htmlPreview";

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
  // An artifact with nothing in it says so. Synthesizing a body here produced a page that
  // looked like a real preview — a heading, a line of filler and a "Preview action" button —
  // sitting next to the genuine article in a second tab.
  if (item.body === undefined || item.body.trim() === "") {
    return <div className="empty-state">{copy.emptyNoArtifact}</div>;
  }
  const body = item.body;
  // The extension says "html"; the body decides whether there is a page to render. A `.html`
  // tab holding something else (a tool's JSON receipt, for instance) shows its source rather
  // than being dressed up as a page.
  if (kind === "html" && looksLikeHtmlDocument(body)) {
    return <iframe className="html-output-preview" title={item.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(body)} />;
  }
  if (kind === "markdown") {
    return <div className="markdown-preview">{renderMarkdown(body, copy)}</div>;
  }
  if (kind === "data") {
    return <pre data-language="json">{normalizeJsonPreview(body)}</pre>;
  }
  return <pre data-language={language}>{body}</pre>;
}

/**
 * Whether there is a page here to render.
 *
 * A full document renders as itself; a bare fragment (`<main>…</main>`) still renders once
 * wrapped. Anything without markup at all is not a page, and dressing it up as one is how a
 * tool's JSON receipt came to be displayed as a styled card with a "Preview action" button.
 */
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
