import type { AgentHarnessId } from "./harnessCatalog.ts";
import type { PiPromptAttachment } from "./piClient.ts";
import type { StoredConversation } from "./conversationStore.ts";

export type NativeTurnCheckpoint =
  | { harness: "pi"; sessionId: string; sourceId: string; beforeEntryId: string | null }
  | { harness: "claude-code"; sessionId: string; afterMessageId: string }
  | { harness: "codex"; sessionId: string; turnId: string };
export type StoredTurn = {
  runId: string; harness: AgentHarnessId; prompt: string; attachments?: PiPromptAttachment[];
  native?: NativeTurnCheckpoint;
};
export type NativeBranch =
  | { harness: "pi"; sessionId: string; sourceId: string; entryId: string }
  | { harness: "claude-code"; sessionId: string; messageId: string }
  | { harness: "codex"; sessionId: string; beforeTurnId: string };
export type ConversationBranch = { sourceId: string; beforeRunId: string; native?: NativeBranch };

const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
const conversationId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) && value !== "." && value !== "..";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function validNative(value: unknown, branch = false): boolean {
  const native = record(value);
  if (!id(native.sessionId)) return false;
  if (native.harness === "pi") return conversationId(native.sourceId) && (branch ? id(native.entryId) : native.beforeEntryId === null || id(native.beforeEntryId));
  if (native.harness === "claude-code") return id(branch ? native.messageId : native.afterMessageId);
  return native.harness === "codex" && id(branch ? native.beforeTurnId : native.turnId);
}
export function validBranchMetadata(turns: unknown, branch: unknown): boolean {
  if (turns !== undefined && (!Array.isArray(turns) || turns.some(value => {
    const turn = record(value);
    return typeof turn.runId !== "string" || !turn.runId || typeof turn.prompt !== "string"
      || !["pi", "claude-code", "codex"].includes(String(turn.harness))
      || (turn.native !== undefined && (!validNative(turn.native) || record(turn.native).harness !== turn.harness))
      || (turn.attachments !== undefined && (!Array.isArray(turn.attachments) || turn.attachments.some(value => {
        const file = record(value);
        return !["assistant", "planner", "builder", "shared"].includes(String(file.scope)) || typeof file.path !== "string";
      })));
  }))) return false;
  const source = record(branch);
  return branch === undefined || (conversationId(source.sourceId) && typeof source.beforeRunId === "string" && Boolean(source.beforeRunId)
    && (source.native === undefined || validNative(source.native, true)));
}

export class ConversationBranchError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

/** A branch excludes the selected request. Never reconstruct model context from rendered text. */
export function branchPrefix(source: StoredConversation, beforeRunId: string) {
  const turn = source.turns?.find(turn => turn.runId === beforeRunId);
  const index = source.events.findIndex(event => event.runId === beforeRunId);
  if (!turn || index < 0) throw new ConversationBranchError("This turn has no saved branch information. Start a new conversation instead.");
  const events = source.events.slice(0, index);
  const runIds = new Set(events.map(event => event.runId));
  const turns = source.turns!.filter(turn => runIds.has(turn.runId));
  if (turns.some(previous => previous.harness !== turn.harness)) throw new ConversationBranchError("Cannot branch across an engine change.");
  let native: NativeBranch | undefined;
  if (events.length) {
    if (turn.native?.harness === "pi" && turn.native.beforeEntryId) {
      native = { harness: "pi", sessionId: turn.native.sessionId, sourceId: turn.native.sourceId, entryId: turn.native.beforeEntryId };
    } else if (turn.native?.harness === "codex") {
      native = { harness: "codex", sessionId: turn.native.sessionId, beforeTurnId: turn.native.turnId };
    } else if (turn.harness === "claude-code") {
      const previous = turns.find(previous => previous.runId === events.at(-1)?.runId);
      const terminal = events.at(-1);
      if (previous?.native?.harness === "claude-code" && terminal?.type === "run.finished" && terminal.payload.status === "success") {
        native = { harness: "claude-code", sessionId: previous.native.sessionId, messageId: previous.native.afterMessageId };
      }
    }
    if (!native) throw new ConversationBranchError("The native boundary for this turn is unavailable. The original conversation has not been changed.");
  }
  return { events, turns, branch: { sourceId: source.id, beforeRunId, native } satisfies ConversationBranch,
    draft: { prompt: turn.prompt, attachments: turn.attachments ?? [] } };
}
