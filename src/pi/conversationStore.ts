import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentUXEvent } from "@agent-ux/protocol";

import type { AgentHarnessId, AgentPresetId } from "./harnessCatalog.ts";

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
  events: AgentUXEvent[];
};

export type ConversationSummary = Omit<StoredConversation, "events" | "cliSession"> & { eventCount: number };

const MAX_CONVERSATIONS = 200;
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
  const cache = new Map<string, StoredConversation>();
  mkdirSync(dir, { recursive: true });

  const fileOf = (id: string) => {
    if (!ID_PATTERN.test(id)) throw new Error("Conversation id is invalid.");
    return join(dir, `${encodeURIComponent(id)}.json`);
  };

  const read = (id: string): StoredConversation | undefined => {
    const cached = cache.get(id);
    if (cached) return cached;
    try {
      const value = JSON.parse(readFileSync(fileOf(id), "utf8")) as StoredConversation;
      cache.set(id, value);
      return value;
    } catch {
      return undefined;
    }
  };

  /** Write to a temp file and rename, so a crash mid-write never leaves half a transcript. */
  const write = (conversation: StoredConversation) => {
    cache.set(conversation.id, conversation);
    const file = fileOf(conversation.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(conversation));
    renameSync(`${file}.tmp`, file);
  };

  const list = (): ConversationSummary[] => {
    const summaries: ConversationSummary[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const conversation = read(decodeURIComponent(name.slice(0, -5)));
      if (!conversation) continue;
      const { events, cliSession: _cliSession, ...summary } = conversation;
      summaries.push({ ...summary, eventCount: events.length });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const prune = () => {
    const all = list();
    for (const stale of all.slice(MAX_CONVERSATIONS)) remove(stale.id);
  };

  const remove = (id: string) => {
    cache.delete(id);
    rmSync(fileOf(id), { force: true });
  };

  return {
    dir,
    list,
    get: read,
    remove,
    /** Open (or create) the conversation a turn is about to run in. */
    begin(id: string, agentPreset: AgentPresetId, prompt: string): StoredConversation {
      const now = Date.now();
      const existing = read(id);
      const conversation: StoredConversation = existing
        ? { ...existing, agentPreset, updatedAt: now }
        : { id, title: conversationTitle(prompt), createdAt: now, updatedAt: now, agentPreset, events: [] };
      write(conversation);
      if (!existing) prune();
      return conversation;
    },
    /** Keep events in memory as they stream; `flush` persists them. */
    append(id: string, event: AgentUXEvent) {
      const conversation = read(id);
      if (!conversation) return;
      conversation.events.push({ ...event, seq: conversation.events.length + 1 } as AgentUXEvent);
      conversation.updatedAt = Date.now();
    },
    flush(id: string) {
      const conversation = read(id);
      if (conversation) write(conversation);
    },
    setCliSession(id: string, cliSession: StoredConversation["cliSession"]) {
      const conversation = read(id);
      if (!conversation) return;
      conversation.cliSession = cliSession;
      write(conversation);
    },
    /** A new session in the same conversation slot starts with an empty transcript. */
    reset(id: string) {
      remove(id);
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
