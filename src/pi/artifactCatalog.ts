import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createAgentUXViewModel, type AgentUXArtifactTimelineItem } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { artifactAuthor, artifactEventForReplay } from "../runtime/artifactContent.ts";
import { isVersionedArtifactId, type ArtifactVersion, type ArtifactVersionsResponse } from "../runtime/artifactVersions.ts";
import { artifactMatchesQuery, artifactTimestamps, type ArtifactCatalogEntry, type ArtifactCatalogPage } from "../runtime/artifactCatalog.ts";
import { identityEventForReplay } from "../runtime/replayIdentity.ts";
import { workArtifacts } from "../runtime/workArtifacts.ts";
import { childConversationId, isChildConversationId } from "./groupChat.ts";
import { isAgentPresetId, type AgentPresetId } from "./harnessCatalog.ts";
import type { ConversationStore } from "./conversationStore.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";
import { openWorkspaceFile, WorkspaceFileError } from "./workspaceFiles.ts";
import { defaultSecretPaths } from "./permissionPolicy.ts";
import { ArtifactVersionStore, type StoredArtifactVersion } from "./artifactVersions.ts";

export class ArtifactCatalogError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
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

export type PublishedArtifactIdentity = {
  conversationId: string;
  sourceConversationId: string;
  artifactId: string;
  sourceArtifactId: string;
  eventArtifactId: string;
  eventRunId: string;
  agent: AgentPresetId;
  scope: "shared" | AgentPresetId;
  path: string;
  name: string;
  title: string;
};

function validateVersionLookup(conversationId: string, artifactId: string): void {
  if (!conversationId || conversationId.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(conversationId) || isChildConversationId(conversationId)) {
    throw new ArtifactCatalogError("Choose a visible conversation.", 400);
  }
  if (!artifactId || artifactId.length > 2048) throw new ArtifactCatalogError("Invalid artifact identity.", 400);
}

async function publicVersionArtifactIndex(options: {
  store: Pick<ConversationStore, "get">;
  layout: WorkspaceLayout;
  excluded: readonly string[];
  bots?: readonly { id: string; presetId: AgentPresetId }[];
  conversationId: string;
  conversation: NonNullable<ReturnType<ConversationStore["get"]>>;
}): Promise<Map<string, PublishedArtifactIdentity>> {
  const roots = Object.entries(options.layout.agents) as [AgentPresetId, string][];
  if (options.layout.shared) roots.push(["shared" as AgentPresetId, options.layout.shared]);
  const canonicalRoots = new Map(await Promise.all(roots.map(async ([scope, root]) => [root, await canonicalPath(root)] as const)));
  const blocked = await Promise.all([...defaultSecretPaths(), ...options.excluded].map(canonicalPath));
  const createdTitles = new Map<string, string>();
  for (const event of options.conversation.events) {
    if (event.type !== "artifact.created" || (event.visibility && event.visibility !== "public") || typeof event.runId !== "string"
      || typeof event.payload.artifactId !== "string" || typeof event.payload.title !== "string") continue;
    const key = `${event.runId}\0${event.payload.artifactId}`;
    if (!createdTitles.has(key)) createdTitles.set(key, event.payload.title);
  }
  const result = new Map<string, PublishedArtifactIdentity>();
  for (const event of options.conversation.events) {
    if (event.type !== "artifact.finished" || (event.visibility && event.visibility !== "public") || event.payload.status !== "success"
      || typeof event.payload.artifactId !== "string" || typeof event.runId !== "string" || typeof event.payload.uri !== "string" || !event.payload.uri.startsWith("file://")) continue;
    const projected = identityEventForReplay(event).payload.artifactId;
    if (typeof projected !== "string" || !isVersionedArtifactId(projected)) continue;
    const path = event.payload.uri.slice(7);
    if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((part: string) => part.startsWith("."))) continue;
    const author = artifactAuthor(projected);
    const agent = author ? isAgentPresetId(author) ? author
      : options.conversation.group?.participants?.find(bot => bot.id === author)?.presetId ?? options.bots?.find(bot => bot.id === author)?.presetId
      : options.conversation.agentPreset;
    if (!agent || !isAgentPresetId(agent)) continue;
    const absolute = resolve(options.layout.agents[agent], path);
    const candidates = [[agent, options.layout.agents[agent]], ["shared", options.layout.shared]] as const;
    const root = candidates.find(([, dir]) => dir && (absolute.startsWith(`${resolve(dir)}${sep}`)
      || absolute.startsWith(`${canonicalRoots.get(dir)!}${sep}`)));
    if (!root) continue;
    const base = absolute.startsWith(`${resolve(root[1]!)}${sep}`) ? resolve(root[1]!) : canonicalRoots.get(root[1]!)!;
    const filePath = isAbsolute(path) ? relative(base, absolute).split(sep).join("/") : path;
    if (blocked.some(privatePath => within(privatePath, resolve(base, filePath)))) continue;
    const eventArtifactId = event.payload.artifactId;
    const sourceArtifactId = author && eventArtifactId.startsWith(`${author}~`) ? eventArtifactId.slice(author.length + 1) : eventArtifactId;
    result.set(projected, { conversationId: options.conversationId, sourceConversationId: options.conversation.group && author ? childConversationId(options.conversationId, author) : options.conversationId,
      artifactId: projected, sourceArtifactId, eventArtifactId,
      eventRunId: event.runId, agent, scope: root[0], path: filePath, name: filePath.split("/").at(-1)!,
      title: createdTitles.get(`${event.runId}\0${eventArtifactId}`) ?? filePath });
  }
  return result;
}

/** Resolve an exact public artifact event before consulting the host-owned version store. */
export async function resolvePublishedArtifactIdentity(options: {
  store: Pick<ConversationStore, "get">;
  layout: WorkspaceLayout;
  excluded: readonly string[];
  bots?: readonly { id: string; presetId: AgentPresetId }[];
  conversationId: string;
  artifactId: string;
}): Promise<PublishedArtifactIdentity> {
  const { conversationId, artifactId } = options;
  validateVersionLookup(conversationId, artifactId);
  const conversation = options.store.get(conversationId);
  if (!conversation) throw new ArtifactCatalogError("Conversation not found.", 404);
  const identity = (await publicVersionArtifactIndex({ ...options, conversation })).get(artifactId);
  if (!identity) throw new ArtifactCatalogError("Saved artifact version not found.", 404);
  return identity;
}

export async function artifactVersionsResponse(options: {
  store: Pick<ConversationStore, "get">;
  versions: ArtifactVersionStore;
  layout: WorkspaceLayout;
  excluded: readonly string[];
  bots?: readonly { id: string; presetId: AgentPresetId }[];
  conversationId: string;
  artifactId: string;
}): Promise<ArtifactVersionsResponse> {
  validateVersionLookup(options.conversationId, options.artifactId);
  const conversation = options.store.get(options.conversationId);
  if (!conversation) throw new ArtifactCatalogError("Conversation not found.", 404);
  const index = await publicVersionArtifactIndex({ ...options, conversation });
  const identity = index.get(options.artifactId);
  if (!identity) throw new ArtifactCatalogError("Saved artifact version not found.", 404);
  const records = await options.versions.list({ conversationId: identity.conversationId, path: identity.path, agent: identity.agent, scope: identity.scope });
  const publicRecords: StoredArtifactVersion[] = records.filter(record => {
    const event = index.get(record.artifactId);
    return Boolean(event && event.sourceConversationId === identity.sourceConversationId && event.sourceConversationId === record.sourceConversationId && event.path === record.path && event.scope === record.scope && event.agent === record.agent && event.sourceArtifactId === record.sourceArtifactId
      && event.eventArtifactId === record.eventArtifactId && event.eventRunId === record.runId);
  });
  const selected = publicRecords.find(record => record.artifactId === identity.artifactId && record.sourceArtifactId === identity.sourceArtifactId
    && record.eventArtifactId === identity.eventArtifactId && record.runId === identity.eventRunId);
  if (!selected) throw new ArtifactCatalogError("Saved artifact version not found.", 404);
  const versions: ArtifactVersion[] = publicRecords.map(record => ({ versionId: record.versionId, artifactId: record.artifactId,
    createdAt: record.createdAt, size: record.size, sha256: record.sha256 }));
  return { versions, selectedVersionId: selected.versionId, source: { scope: identity.scope, path: identity.path } };
}

/** Search registered deliverables, never scan workspace contents or return transcript/file bytes. */
export async function listArtifactCatalog(options: {
  store: Pick<ConversationStore, "list" | "get" | "readErrors">;
  layout: WorkspaceLayout;
  excluded: readonly string[];
  versions?: ArtifactVersionStore;
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
    try {
      const timeline = createAgentUXViewModel(replayAgentUXEvents(events)).timeline;
      // Ordinary artifacts keep the existing path de-duplication. Preserved deliveries are
      // distinct immutable identities even when their source path is reused.
      const versioned = timeline.filter((item): item is AgentUXArtifactTimelineItem => item.kind === "artifact" && item.status === "success"
        && item.uri?.startsWith("file://") && isVersionedArtifactId(item.id));
      artifacts = [...timeline.flatMap(item => workArtifacts([item])).filter(item => !isVersionedArtifactId(item.id)), ...versioned];
    }
    catch { unreadable++; continue; }
    const files = new Map<string, ArtifactCatalogEntry>();
    const versionedFiles: ArtifactCatalogEntry[] = [];
    const versionIndex = options.versions ? await publicVersionArtifactIndex({ store: options.store, layout: options.layout, excluded: options.excluded,
      bots: options.bots, conversationId: conversation.id, conversation }) : undefined;
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
      const root = roots.find(([, dir]) => dir && (absolute.startsWith(`${resolve(dir)}${sep}`)
        || absolute.startsWith(`${canonicalRoots.get(dir)!}${sep}`)));
      if (!root) continue;
      const base = absolute.startsWith(`${resolve(root[1]!)}${sep}`) ? resolve(root[1]!) : canonicalRoots.get(root[1]!)!;
      const filePath = isAbsolute(path) ? relative(base, absolute).split(sep).join("/") : path;
      if (blocked.some(privatePath => within(privatePath, resolve(canonicalRoots.get(root[1]!)!, filePath)))) continue;
      let available = true;
      if (isVersionedArtifactId(artifact.id)) {
        if (!options.versions) continue;
        const identity = versionIndex?.get(artifact.id);
        if (!identity) continue;
        const record = (await options.versions.list({ conversationId: conversation.id, path: filePath, agent, scope: root[0] }))
          .find(candidate => candidate.sourceConversationId === identity.sourceConversationId && candidate.artifactId === identity.artifactId && candidate.sourceArtifactId === identity.sourceArtifactId
            && candidate.eventArtifactId === identity.eventArtifactId && candidate.runId === identity.eventRunId);
        if (!record) continue; // Branches and orphan metadata must not invent a readable version.
      } else {
        try {
          const entry = await openWorkspaceFile(options.layout, root[0], filePath, options.excluded);
          await entry.file.close();
        } catch (error) {
          if (error instanceof WorkspaceFileError && error.status === 404) available = false;
          else continue; // Private, linked, invalid or unknown file boundaries never become search results.
        }
      }
      const name = filePath.split("/").at(-1)!;
      if (!artifactMatchesQuery(`${name}\n${filePath}\n${conversation.title}`, query)) continue;
      const row = { conversationId: conversation.id, conversationTitle: conversation.title, artifactId: artifact.id,
        name, path: filePath, ...(times[artifact.id] !== undefined ? { timestamp: times[artifact.id] } : {}), available } satisfies ArtifactCatalogEntry;
      if (isVersionedArtifactId(artifact.id)) versionedFiles.push(row);
      else files.set(resolve(base, filePath), row);
    }
    rows.push(...versionedFiles, ...files.values());
    if (candidateCount > LIMITS.artifacts) break;
  }
  const ordered = rows.sort((a, b) => compare(position(a), position(b))).filter(row => !after || compare(position(row), after) > 0);
  const page = ordered.slice(0, limit);
  return { artifacts: page, truncated, unreadable, ...(ordered.length > limit
    ? { nextCursor: Buffer.from(JSON.stringify([query, scope, ...position(page.at(-1)!)] )).toString("base64url") } : {}) };
}
