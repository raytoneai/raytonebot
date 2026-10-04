import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentUXEvent } from "@agent-ux/protocol";

import { isAgentPresetId, type AgentHarnessId, type AgentPresetId } from "./harnessCatalog.ts";
import { branchPrefix, ConversationBranchError, validBranchMetadata, type ConversationBranch, type NativeTurnCheckpoint, type StoredTurn } from "./conversationBranch.ts";
import { matchConversationText, type ConversationTextMatch } from "./conversationSearch.ts";
import { createConversationCache } from "./conversationCache.ts";

/**
 * Conversations on disk, so a reload, a server restart or a redeploy keeps the sidebar and
 * every transcript. Node-only. One JSON file per conversation under the data directory (inside
 * the protected ~/.raytonebot by default, so agents cannot read it without asking).
 *
 * Events are stored the way the browser shows them: each appended event gets the next
 * conversation-wide `seq`, matching `appendPiConversationEvents`.
 */
export type StoredConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentPreset: AgentPresetId;
  /** The CLI harness's own session, so a follow-up turn resumes it after a restart. */
  cliSession?: { harness: AgentHarnessId; id: string };
  /** Exact Pi context; null before SDK acceptance, absent in legacy records. */
  piSessionId?: string | null;
  turns?: StoredTurn[];
  branch?: ConversationBranch;
  events: AgentUXEvent[];
};

export type ConversationSummary = Omit<StoredConversation, "events" | "cliSession" | "piSessionId" | "turns" | "branch"> & { eventCount: number; snippet?: string; textId?: string; matches?: ConversationTextMatch[] };

const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,160}$/;

export function defaultDataDir(): string {
  return process.env.RAYTONEBOT_DATA_DIR?.trim() || join(homedir(), ".raytonebot", "data");
}

export function conversationTitle(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized || "New conversation";
}

export function createConversationStore(dataDir = defaultDataDir()) {
  const dir = join(dataDir, "conversations");
  const cache = createConversationCache();
  const unreadable = new Set<string>();
  mkdirSync(dir, { recursive: true });

  const fileOf = (id: string) => {
    if (!ID_PATTERN.test(id)) throw new Error("Conversation id is invalid.");
    return join(dir, `${encodeURIComponent(id)}.json`);
  };

  const read = (id: string): StoredConversation | undefined => {
    const file = fileOf(id);
    const cached = cache.get(id);
    if (cached) return cached;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as StoredConversation;
      if (!value || value.id !== id || typeof value.title !== "string" || !isAgentPresetId(value.agentPreset)
        || (value.piSessionId != null && (typeof value.piSessionId !== "string" || !value.piSessionId))
        || !validBranchMetadata(value.turns, value.branch)
        || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Array.isArray(value.events)
        || value.events.some((event) => !event || typeof event.type !== "string" || !event.payload || typeof event.payload !== "object")) {
        throw new Error("Invalid conversation data");
      }
      cache.set(value);
      return value;
    } catch (error) {
      cache.delete(id);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // Do not expose transcript fragments from JSON.parse errors, or overwrite unreadable files.
      throw new Error(`Saved conversation ${id} could not be read. Its file has not been changed.`);
    }
  };

  /** Write to a temp file and rename, so a crash mid-write never leaves half a transcript. */
  const write = (conversation: StoredConversation) => {
    const file = fileOf(conversation.id);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(conversation));
      renameSync(`${file}.tmp`, file);
    } catch {
      // Re-read the last committed file; buffered events must not look saved after a failure.
      cache.delete(conversation.id);
      throw new Error(`Conversation ${conversation.id} could not be saved. Check the host's storage before continuing.`);
    }
    cache.set(conversation);
  };

  // ponytail: cold lists and text searches scan files; warm lists need only cached metadata.
  const list = (query?: string): ConversationSummary[] => {
    const summaries: ConversationSummary[] = [];
    unreadable.clear();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      let id = name.slice(0, -5);
      try {
        id = decodeURIComponent(id);
        const cached = cache.summary(id);
        if (!query && cached) { summaries.push({ ...cached }); continue; }
        const conversation = read(id);
        if (!conversation) continue;
        const { events, cliSession: _cliSession, piSessionId: _piSessionId, turns: _turns, branch: _branch, ...summary } = conversation;
        const match = query ? matchConversationText(summary.title, events, query) : {};
        if (match) summaries.push({ ...summary, eventCount: events.length, ...match });
      } catch { unreadable.add(id); }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const remove = (id: string) => {
    cache.delete(id);
    rmSync(fileOf(id), { force: true });
  };

  return {
    dir,
    list,
    readErrors: () => [...unreadable],
    get: read,
    remove,
    /** Open (or create) the conversation a turn is about to run in. */
    begin(id: string, agentPreset: AgentPresetId, prompt: string): StoredConversation {
      const now = Date.now();
      const existing = read(id);
      const conversation: StoredConversation = existing
        ? { ...existing, agentPreset, updatedAt: now }
        : { id, title: conversationTitle(prompt), createdAt: now, updatedAt: now, agentPreset, piSessionId: null, events: [] };
      write(conversation);
      return conversation;
    },
    /** Keep events in memory as they stream; `flush` persists them. */
    append(id: string, event: AgentUXEvent) {
      const conversation = read(id);
      if (!conversation) return;
      conversation.events.push({ ...event, seq: conversation.events.length + 1 } as AgentUXEvent);
      conversation.updatedAt = Date.now();
      cache.set(conversation, true);
    },
    flush(id: string) {
      const conversation = read(id);
      if (conversation) write(conversation);
    },
    setCliSession(id: string, cliSession: StoredConversation["cliSession"]) {
      const conversation = read(id);
      if (!conversation) return;
      write({ ...conversation, cliSession });
    },
    setPiSession(id: string, piSessionId: string) {
      const conversation = read(id);
      if (conversation && conversation.piSessionId !== piSessionId) write({ ...conversation, piSessionId });
    },
    saveTurn(id: string, turn: StoredTurn) {
      const conversation = read(id);
      if (!conversation) throw new Error("Conversation is unavailable.");
      if (!validBranchMetadata([turn], undefined)) throw new Error("Invalid saved turn metadata.");
      if (conversation.turns?.some(item => item.runId === turn.runId)) throw new Error("This request id has already been submitted.");
      write({ ...conversation, turns: [...(conversation.turns ?? []), structuredClone(turn)] });
    },
    saveNativeTurn(id: string, runId: string, native: NativeTurnCheckpoint) {
      const conversation = read(id);
      if (!conversation?.turns?.some(turn => turn.runId === runId)) throw new Error("The native turn has no saved request.");
      const turns = conversation.turns.map(turn => turn.runId === runId ? { ...turn, native } : turn);
      if (!validBranchMetadata(turns, undefined)) throw new Error("Invalid native turn metadata.");
      write({ ...conversation, ...(native.harness === "pi" ? { piSessionId: native.sessionId } : {}),
        turns });
    },
    branch(id: string, sourceId: string, beforeRunId: string) {
      if (read(id)) throw new ConversationBranchError("The branch already exists.");
      const source = read(sourceId);
      if (!source) throw new ConversationBranchError("Conversation not found.", 404);
      const { events, turns, branch, draft } = branchPrefix(source, beforeRunId);
      const now = Date.now();
      const conversation: StoredConversation = { id, title: `↳ ${source.title}`, agentPreset: source.agentPreset,
        createdAt: now, updatedAt: now, piSessionId: null, events: structuredClone(events), turns: structuredClone(turns), branch };
      write(conversation);
      return { conversation, draft };
    },
    /** A new session in the same conversation slot starts with an empty transcript. */
    reset(id: string) {
      remove(id);
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
