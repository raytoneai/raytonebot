import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { HostTools } from "./memories.ts";
import type { AgentPresetId } from "./harnessCatalog.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";
import { openWorkspaceFile } from "./workspaceFiles.ts";
import { mediaType } from "../runtime/mediaType.ts";

export type PublishedArtifact = { artifactId: string; title: string; uri: string; mimeType: string };

/** Explicit registration only. No directory scans and no file bytes in conversation history. */
export function artifactTools(layout: WorkspaceLayout, agent: AgentPresetId, excluded: readonly string[], publish: (file: PublishedArtifact) => void): HostTools {
  return {
    specs: [{ name: "publish_artifact", description: "Register an existing deliverable in this conversation's output panel. After creating HTML, PDF, images or documents with shell tools, call this with its path. This does not publish to the internet. Only your own or the shared workspace is allowed; report failures rather than claiming a file was registered.",
      inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["path"], additionalProperties: false } }],
    async run(name, args, signal) {
      try {
        signal?.throwIfAborted();
        const path = (args as { path?: unknown } | null)?.path;
        if (name !== "publish_artifact" || typeof path !== "string" || !path.trim()) throw new Error("An existing workspace file path is required.");
        const absolute = resolve(layout.agents[agent], path);
        const roots = [[agent, layout.agents[agent]], ["shared", layout.shared]] as const;
        const match = roots.find(([, root]) => root && absolute.startsWith(`${resolve(root)}/`));
        if (!match) throw new Error("Artifact must belong to this agent or the shared workspace.");
        // Preserve the original relative spelling so hidden/traversal checks cannot be normalized away.
        const file = await openWorkspaceFile(layout, match[0], isAbsolute(path) ? relative(match[1]!, absolute) : path, excluded);
        await file.file.close();
        signal?.throwIfAborted();
        const artifact: PublishedArtifact = { artifactId: `published_${randomUUID()}`, title: file.target,
          uri: `file://${file.target}`, mimeType: mediaType(file.name) ?? (/\.html?$/i.test(file.name) ? "text/html" : /\.md$/i.test(file.name) ? "text/markdown" : "text/plain") };
        publish(artifact);
        return { text: JSON.stringify({ registered: true, ...artifact, size: file.size }), isError: false };
      } catch (error) { return { text: error instanceof Error ? error.message : "Artifact registration failed.", isError: true }; }
    },
  };
}
