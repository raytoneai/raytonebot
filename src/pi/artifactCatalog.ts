import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { artifactAuthor, artifactEventForReplay } from "../runtime/artifactContent.ts";
import { artifactMatchesQuery, artifactTimestamps, type ArtifactCatalogEntry, type ArtifactCatalogPage } from "../runtime/artifactCatalog.ts";
import { identityEventForReplay } from "../runtime/replayIdentity.ts";
import { workArtifacts } from "../runtime/workArtifacts.ts";
import { isChildConversationId } from "./groupChat.ts";
import { isAgentPresetId, type AgentPresetId } from "./harnessCatalog.ts";
import type { ConversationStore } from "./conversationStore.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";
import { openWorkspaceFile, WorkspaceFileError } from "./workspaceFiles.ts";
import { defaultSecretPaths } from "./permissionPolicy.ts";

export class ArtifactCatalogError extends Error { readonly status = 400; }
const LIMITS = { conversations: 1000, events: 200_000, artifacts: 2000 };
type Position = [number, string, string];
const position = (entry: ArtifactCatalogEntry): Position => [entry.timestamp ?? 0, entry.conversationId, entry.artifactId];
const compare = (a: Position, b: Position) => b[0] - a[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Keep missing paths private too, including hosts whose workspace parent has an alias. */
async function canonicalPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    const actual = await realpath(ancestor).catch(() => undefined);
    if (actual) return resolve(actual, ...suffix);
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    suffix.unshift(basename(ancestor)); ancestor = parent;
  }
}

/** Search registered deliverables, never scan workspace contents or return transcript/file bytes. */
export async function listArtifactCatalog(options: {
  store: Pick<ConversationStore, "list" | "get" | "readErrors">;
  layout: WorkspaceLayout;
  excluded: readonly string[];
  bots?: readonly { id: string; presetId: AgentPresetId }[];
  query?: string;
  conversationId?: string;
  limit?: number;
  cursor?: string;
}): Promise<ArtifactCatalogPage> {
  const query = (options.query ?? "").trim(), scope = options.conversationId ?? "", limit = options.limit ?? 50;
  if (query.length > 200 || scope.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArtifactCatalogError("Invalid artifact query or page size.");
  if (scope && (!/^[a-zA-Z0-9._:-]+$/.test(scope) || isChildConversationId(scope))) throw new ArtifactCatalogError("Choose a visible conversation.");
  let after: Position | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 4096) throw new Error();
      const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 5 || value[0] !== query || value[1] !== scope
        || !Number.isFinite(value[2]) || typeof value[3] !== "string" || typeof value[4] !== "string") throw new Error();
      after = value.slice(2) as Position;
    } catch { throw new ArtifactCatalogError("Artifact cursor is invalid. Start a new search."); }
  }
  const summaries = options.store.list().filter(row => !isChildConversationId(row.id) && (!scope || row.id === scope));
  const blocked = await Promise.all([...defaultSecretPaths(), ...options.excluded].map(canonicalPath));
  const canonicalRoots = new Map(await Promise.all(Object.values(options.layout.agents).concat(options.layout.shared ? [options.layout.shared] : [])
    .map(async root => [root, await canonicalPath(root)] as const)));
  let unreadable = options.store.readErrors().filter(id => !isChildConversationId(id) && (!scope || id === scope)).length;
  let truncated = summaries.length > LIMITS.conversations, eventCount = 0, candidateCount = 0;
  const rows: ArtifactCatalogEntry[] = [];
  for (const summary of summaries.slice(0, LIMITS.conversations)) {
    let conversation;
    try { conversation = options.store.get(summary.id); } catch { unreadable++; continue; }
    if (!conversation) continue;
    if (eventCount + conversation.events.length > LIMITS.events) { truncated = true; break; }
    eventCount += conversation.events.length;
    const events = conversation.events.filter(event => event.type.startsWith("artifact.") && (!event.visibility || event.visibility === "public"))
      .map(identityEventForReplay).map(artifactEventForReplay);
    const times = artifactTimestamps(events);
    let artifacts: ReturnType<typeof workArtifacts>;
    try { artifacts = createAgentUXViewModel(replayAgentUXEvents(events)).timeline.flatMap(item => workArtifacts([item])); }
    catch { unreadable++; continue; }
    const files = new Map<string, ArtifactCatalogEntry>();
    for (const artifact of artifacts) {
      if (artifact.status !== "success" || typeof artifact.uri !== "string" || !artifact.uri.startsWith("file://")) continue;
      if (++candidateCount > LIMITS.artifacts) { truncated = true; break; }
      const path = artifact.uri.slice(7);
      // Do not normalize hidden/traversal segments away before applying the existing file boundary.
      if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((part: string) => part.startsWith("."))) continue;
      const author = artifactAuthor(artifact.id);
      const agent = author ? isAgentPresetId(author) ? author
        : conversation.group?.participants?.find(bot => bot.id === author)?.presetId ?? options.bots?.find(bot => bot.id === author)?.presetId
        : conversation.agentPreset;
      if (!agent || !isAgentPresetId(agent)) continue;
      const absolute = resolve(options.layout.agents[agent], path);
      const roots = [[agent, options.layout.agents[agent]], ["shared", options.layout.shared]] as const;
      const root = roots.find(([, dir]) => dir && absolute.startsWith(`${resolve(dir)}${sep}`));
      if (!root) continue;
      const filePath = isAbsolute(path) ? relative(root[1]!, absolute).split(sep).join("/") : path;
      if (blocked.some(privatePath => within(privatePath, resolve(canonicalRoots.get(root[1]!)!, filePath)))) continue;
      let available = true;
      try {
        const entry = await openWorkspaceFile(options.layout, root[0], filePath, options.excluded);
        await entry.file.close();
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.status === 404) available = false;
        else continue; // Private, linked, invalid or unknown file boundaries never become search results.
      }
      const name = filePath.split("/").at(-1)!;
      if (!artifactMatchesQuery(`${name}\n${filePath}\n${conversation.title}`, query)) continue;
      files.set(absolute, { conversationId: conversation.id, conversationTitle: conversation.title, artifactId: artifact.id,
        name, path: filePath, ...(times[artifact.id] !== undefined ? { timestamp: times[artifact.id] } : {}), available });
    }
    rows.push(...files.values());
    if (candidateCount > LIMITS.artifacts) break;
  }
  const ordered = rows.sort((a, b) => compare(position(a), position(b))).filter(row => !after || compare(position(row), after) > 0);
  const page = ordered.slice(0, limit);
  return { artifacts: page, truncated, unreadable, ...(ordered.length > limit
    ? { nextCursor: Buffer.from(JSON.stringify([query, scope, ...position(page.at(-1)!)] )).toString("base64url") } : {}) };
}
