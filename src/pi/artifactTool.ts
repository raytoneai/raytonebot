import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { HostTools } from "./memories.ts";
import type { AgentPresetId } from "./harnessCatalog.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";
import { openWorkspaceFile } from "./workspaceFiles.ts";
import { mediaType } from "../runtime/mediaType.ts";
import { ARTIFACT_VERSION_MAX_BYTES } from "./artifactVersions.ts";

export type PublishedArtifact = { artifactId: string; title: string; uri: string; mimeType: string };
export type PublishedArtifactCapture = {
  versionId: string;
  bytes: Buffer;
  scope: "shared" | AgentPresetId;
  path: string;
  name: string;
};
type PublishArtifact = (file: PublishedArtifact, capture?: PublishedArtifactCapture, signal?: AbortSignal) => void | Promise<void>;

function sameFileStat(a: { dev: bigint | number; ino: bigint | number; size: number; mtimeMs: number; ctimeMs: number }, b: { dev: bigint | number; ino: bigint | number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function readStableCapture(file: Awaited<ReturnType<typeof openWorkspaceFile>>, signal?: AbortSignal): Promise<Buffer> {
  const before = await file.file.stat();
  if (before.size > ARTIFACT_VERSION_MAX_BYTES) throw new Error("A preserved artifact must be 20 MiB or smaller.");
  // One extra byte makes a concurrent growth observable even if the second stat is coarse.
  const bytes = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const result = await file.file.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await file.file.stat();
  if (offset !== before.size || !sameFileStat(before, after)) throw new Error("The file changed while its delivery version was being captured. Read it again and retry.");
  return bytes.subarray(0, before.size);
}

/** Explicit registration only. No directory scans and no file bytes in conversation history. */
export function artifactTools(layout: WorkspaceLayout, agent: AgentPresetId, excluded: readonly string[], publish: PublishArtifact): HostTools {
  return {
    specs: [{ name: "publish_artifact", description: "Register an existing deliverable in this conversation's output panel. After creating HTML, PDF, images or documents with shell tools, call this with its path. This does not publish to the internet. Only your own or the shared workspace is allowed; report failures rather than claiming a file was registered.",
      inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, preserveVersion: { type: "boolean" } }, required: ["path"], additionalProperties: false } }],
    async run(name, args, signal) {
      try {
        signal?.throwIfAborted();
        const input = args as { path?: unknown; preserveVersion?: unknown } | null;
        const path = input?.path;
        const preserveVersion = input?.preserveVersion;
        if (name !== "publish_artifact" || typeof path !== "string" || !path.trim()) throw new Error("An existing workspace file path is required.");
        if (preserveVersion !== undefined && typeof preserveVersion !== "boolean") throw new Error("preserveVersion must be a boolean.");
        const absolute = resolve(layout.agents[agent], path);
        const roots = [[agent, layout.agents[agent]], ["shared", layout.shared]] as const;
        const match = roots.find(([, root]) => root && absolute.startsWith(`${resolve(root)}/`));
        if (!match) throw new Error("Artifact must belong to this agent or the shared workspace.");
        // Preserve the original relative spelling so hidden/traversal checks cannot be normalized away.
        const file = await openWorkspaceFile(layout, match[0], isAbsolute(path) ? relative(match[1]!, absolute) : path, excluded);
        try {
          let capture: PublishedArtifactCapture | undefined;
          const versionId = preserveVersion ? randomUUID() : undefined;
          if (preserveVersion) {
            if (!/\.(?:md|txt|pdf)$/i.test(file.name)) throw new Error("Preserved delivery versions support only .md, .txt and .pdf files.");
            capture = { versionId: versionId!, bytes: await readStableCapture(file, signal), scope: file.scope, path: file.path, name: file.name };
          }
          signal?.throwIfAborted();
          const artifact: PublishedArtifact = { artifactId: preserveVersion ? `published_version_${versionId}` : `published_${randomUUID()}`, title: file.target,
            uri: `file://${file.target}`, mimeType: mediaType(file.name) ?? (/\.html?$/i.test(file.name) ? "text/html" : /\.md$/i.test(file.name) ? "text/markdown" : "text/plain") };
          await publish(artifact, capture, signal);
          return { text: JSON.stringify({ registered: true, ...artifact, ...(capture ? { preservedVersion: true, versionId: capture.versionId } : {}), size: capture?.bytes.length ?? file.size }), isError: false };
        } finally { await file.file.close(); }
      } catch (error) { return { text: error instanceof Error ? error.message : "Artifact registration failed.", isError: true }; }
    },
  };
}
