import type { AgentUXEvent } from "@agent-ux/protocol";

export type ArtifactCatalogEntry = {
  conversationId: string;
  conversationTitle: string;
  /** Same projected identity used by the conversation's existing renderer. */
  artifactId: string;
  name: string;
  path: string;
  timestamp?: number;
  available: boolean;
};
export type ArtifactCatalogPage = { artifacts: ArtifactCatalogEntry[]; nextCursor?: string; truncated: boolean; unreadable: number };
export type ArtifactCatalogContext = {
  conversationId: string;
  conversationTitle: string;
  timestamps?: Record<string, number>;
  openSource(entry: Pick<ArtifactCatalogEntry, "conversationId" | "artifactId">): void;
};

/** Input is already projected with identityEventForReplay, exactly like the displayed timeline. */
export function artifactTimestamps(events: readonly AgentUXEvent[]): Record<string, number> {
  const times: Record<string, number> = Object.create(null);
  for (const event of events) {
    if (event.type.startsWith("artifact.") && typeof event.payload.artifactId === "string" && typeof event.ts === "number" && Number.isFinite(event.ts)) {
      times[event.payload.artifactId] = event.ts;
    }
  }
  return times;
}

export function artifactMatchesQuery(name: string, query: string): boolean {
  return name.normalize("NFC").toLocaleLowerCase().includes(query.trim().normalize("NFC").toLocaleLowerCase());
}
