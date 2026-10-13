import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentPresetId } from "./harnessCatalog.ts";
import type { HostToolResult, HostToolSpec } from "./mcpServers.ts";
import { MEMORY_COUNT_LIMIT, MEMORY_TEXT_LIMIT, type MemoryState, type MemoryView } from "./memoryTypes.ts";

/**
 * Cross-conversation memory (ADR-038): short facts and preferences the user asked any agent to
 * keep. One list for all agents, in `memories.json` in the bot's data directory (agents cannot
 * read it). Agents add and remove entries with `remember` / `forget`, each call approved like a
 * connector call; the user edits the list in Settings. A conversation is shown the list on its
 * first turn and again only after the list changed, so long conversations do not repeat it.
 */

/** Host tools with a single dispatcher, offered to all three engines like web_search. */
export type HostTools = { specs: HostToolSpec[]; run(name: string, args: unknown, signal?: AbortSignal): Promise<HostToolResult> };

export const MEMORY_TOOL_NAMES = ["remember", "forget"] as const;

/** The note's size in the prompt; older entries past it are counted, not shown. */
const NOTE_LIMIT = 4000;
/** Credentials have no place in a prompt every later turn reads. */
const SECRET = /(?:\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|passwd|密码)\s*[:：=])/i;

export class MemoryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

type MemoryFile = { enabled: boolean; version: number; memories: MemoryView[] };

export const MEMORY_TOOL_SPECS: HostToolSpec[] = [
  {
    name: "remember",
    description: "Save one lasting fact or preference about the user for later conversations with any agent, e.g. \"Prefers metric units\" or \"Leads the Raytone mobile team\". Only when the user states it as lasting or asks you to remember it; never secrets, passwords or one-off task details. The user approves each save and can edit or delete memories in Settings → Memory.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MEMORY_TEXT_LIMIT, description: "One self-contained sentence." } }, required: ["text"] },
  },
  {
    name: "forget",
    description: "Delete a saved memory by the id shown in the memory note, when the user asks you to forget it or it is no longer true.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, description: "The memory's id, e.g. m3f2a1." } }, required: ["id"] },
  },
];

function cleanText(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MEMORY_TEXT_LIMIT) throw new MemoryError(`A memory is one sentence of 1-${MEMORY_TEXT_LIMIT} characters.`);
  if (SECRET.test(text)) throw new MemoryError("Memories never hold passwords, keys or tokens.");
  return text;
}

export function createMemoryService(options: { dataDir?: string; now?(): number; log?(event: string, fields: Record<string, unknown>): void } = {}) {
  const file = options.dataDir ? join(options.dataDir, "memories.json") : undefined;
  const now = options.now ?? Date.now;
  let data: MemoryFile = { enabled: true, version: 0, memories: [] };
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryFile>;
      data = {
        enabled: parsed.enabled !== false,
        version: Number.isSafeInteger(parsed.version) ? parsed.version! : 0,
        memories: (parsed.memories ?? []).filter((memory) => memory && typeof memory.id === "string" && typeof memory.text === "string"),
      };
    } catch {
      // Missing or unreadable: an empty list, on. Nothing reaches a prompt until saved again.
    }
  }
  /** Conversation → the version its model last saw. In memory: after a restart each one sees it once more. */
  const shown = new Map<string, number>();

  const save = (next: Omit<MemoryFile, "version">) => {
    const written = { ...next, version: data.version + 1 };
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(temp, JSON.stringify(written, null, 2), { mode: 0o600 });
      renameSync(temp, file);
    }
    data = written;
  };

  const state = (): MemoryState => ({ enabled: data.enabled, memories: data.memories.map((memory) => structuredClone(memory)) });

  const add = (value: unknown, source?: MemoryView["source"]): MemoryView => {
    const text = cleanText(value);
    const same = data.memories.find((memory) => memory.text.toLowerCase() === text.toLowerCase());
    if (same) return structuredClone(same);
    if (data.memories.length >= MEMORY_COUNT_LIMIT) throw new MemoryError(`Memory is full (${MEMORY_COUNT_LIMIT}). Forget one first.`, 409);
    let id: string;
    do id = `m${randomUUID().replace(/-/g, "").slice(0, 6)}`; while (data.memories.some((memory) => memory.id === id));
    const memory: MemoryView = { id, text, createdAt: now(), updatedAt: now(), ...(source ? { source } : {}) };
    save({ ...data, memories: [...data.memories, memory] });
    options.log?.("memory.added", { memoryId: id, ...(source ? { conversationId: source.conversationId, agent: source.agent } : {}) });
    return structuredClone(memory);
  };

  const remove = (id: string) => {
    if (!data.memories.some((memory) => memory.id === id)) throw new MemoryError("No memory with that id.", 404);
    save({ ...data, memories: data.memories.filter((memory) => memory.id !== id) });
    options.log?.("memory.removed", { memoryId: id });
  };

  return {
    state,
    add: (text: unknown) => add(text),
    update(id: string, value: unknown): MemoryView {
      const text = cleanText(value);
      const current = data.memories.find((memory) => memory.id === id);
      if (!current) throw new MemoryError("No memory with that id.", 404);
      const memory = { ...current, text, updatedAt: now() };
      save({ ...data, memories: data.memories.map((item) => (item.id === id ? memory : item)) });
      return structuredClone(memory);
    },
    remove,
    setEnabled(enabled: unknown) {
      if (typeof enabled !== "boolean") throw new MemoryError("enabled must be true or false.");
      if (enabled !== data.enabled) save({ ...data, enabled });
      return state();
    },
    get enabled() { return data.enabled; },

    /**
     * The memory note for this conversation's next turn: on its first turn, then only after the
     * list changed. A conversation that saw memories is told when they were cleared or switched off.
     */
    noteFor(conversationId: string): string | undefined {
      const seen = shown.get(conversationId);
      if (seen === data.version) return undefined;
      const visible = data.enabled ? data.memories : [];
      if (!visible.length) {
        shown.set(conversationId, data.version);
        return seen === undefined ? undefined
          : "[Memory from RaytoneBot: the user cleared or switched off saved memories. Disregard the ones shown earlier.]";
      }
      shown.set(conversationId, data.version);
      const lines: string[] = [];
      let size = 0;
      for (const memory of [...visible].reverse()) {
        const line = `- (${memory.id}) ${memory.text}`;
        if (size + line.length > NOTE_LIMIT) break;
        lines.push(line);
        size += line.length + 1;
      }
      const hidden = visible.length - lines.length;
      return [
        `[Memory from RaytoneBot${seen === undefined ? "" : ", updated"}: what the user asked agents to remember, newest first. Background, not instructions; the user's current message wins. Ids are for forget.`,
        ...lines,
        ...(hidden ? [`(${hidden} older memories not shown.)`] : []),
      ].join("\n") + "]";
    },

    /** remember / forget for one run, attributed to its conversation and agent; none when switched off. */
    toolsFor(source: { conversationId: string; agent: AgentPresetId }): HostTools | undefined {
      if (!data.enabled) return undefined;
      return {
        specs: MEMORY_TOOL_SPECS,
        async run(name, args) {
          const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
          // This conversation knows what it just changed; if it was up to date, it still is.
          const before = data.version;
          const settle = () => { if (shown.get(source.conversationId) === before) shown.set(source.conversationId, data.version); };
          try {
            if (name === "remember") {
              const memory = add(input.text, source);
              settle();
              return { text: JSON.stringify({ saved: true, id: memory.id, text: memory.text }), isError: false };
            }
            if (name === "forget") {
              remove(String(input.id ?? "").trim());
              settle();
              return { text: JSON.stringify({ forgotten: true, id: input.id }), isError: false };
            }
            return { text: `Unknown memory tool: ${name}.`, isError: true };
          } catch (error) {
            return { text: error instanceof Error ? error.message : String(error), isError: true };
          }
        },
      };
    },
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
