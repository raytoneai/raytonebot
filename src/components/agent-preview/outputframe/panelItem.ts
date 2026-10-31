import type { ArtifactVersion } from "../../../runtime/artifactVersions.ts";
import type { PiFileScope } from "../../../pi/piClient.ts";

export type OutputPanelItem = {
  id: string;
  kind: "file" | "review";
  title: string;
  subtitle?: string;
  language?: string;
  body?: string;
  imageSrc?: string;
  mediaSrc?: string;
  mediaStyle?: string;
  downloadUrl?: string;
  /** An actual tool/file reference, never inferred from a display title. */
  workspacePath?: string;
  /** Follow the live artifact by identity, even when its title changes. */
  artifactId?: string;
  /** Changes when the file on disk did (the call that wrote it), so an open preview reads it again. */
  revision?: string;
  /** Source conversation for version metadata and exact-version downloads. */
  conversationId?: string;
  /**
   * Stable published identity used to keep the saved-version catalog attached to
   * this tab while `artifactId` follows a later live workspace write.
   */
  versionOriginArtifactId?: string;
  /** Canonical workspace source returned by the host for current-file fallback. */
  versionSource?: { scope: PiFileScope; path: string };
  /** The selected saved version returned by the host, when one is selected. */
  selectedVersionId?: string;
  /** Historical tabs freeze at their captured bytes; current explicitly follows the workspace. */
  versionSelection?: "current" | "version";
  /** Keep public metadata available to an owner without exposing host storage paths. */
  versions?: readonly ArtifactVersion[];
};

export type OutputPanelOpenRequest = string | Omit<OutputPanelItem, "id"> & { id?: string };

export function languageFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "md" || ext === "mdx") return "markdown";
  return ext || "text";
}

export function fallbackOutputPanelBody(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(lower)) {
    return "image preview";
  }
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(lower)) {
    return `media-generation:audio\nAudio placeholder preview for ${fileName}.`;
  }
  if (/\.(mp4|webm|mov|m4v)$/.test(lower)) {
    return `media-generation:video\nVideo placeholder preview for ${fileName}.`;
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return `<main class="page"><section class="card"><h1>${fileName}</h1><p>Interactive HTML preview is ready.</p><button>Run preview</button></section></main>`;
  }
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return `# ${fileName}\n\n- Summary preview\n- Changes are ready\n\nThis document is rendered as Markdown.`;
  }
  if (lower.endsWith(".json")) {
    return JSON.stringify({ file: fileName, status: "ready", preview: true }, null, 2);
  }
  return `// ${fileName}\n// File preview is ready.`;
}

/**
 * Turn an artifact-open request (a bare path, or a partial item) into a panel item.
 * Lives here rather than in App.tsx so the exported scaffold opens artifacts the same
 * way the configurator does.
 */
export function normalizeOutputPanelRequest(request: OutputPanelOpenRequest): OutputPanelItem {
  if (typeof request === "string") {
    const title = request.split("/").filter(Boolean).pop() ?? request;
    return {
      id: `file:${request}`,
      kind: "file",
      title,
      subtitle: request,
      language: languageFromFileName(title),
      workspacePath: request,
    };
  }
  return {
    ...request,
    id: request.id ?? `${request.kind}:${request.title}`,
    language: request.language ?? languageFromFileName(request.title),
  };
}
