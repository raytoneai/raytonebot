import type { AgentUXEvent } from "@agent-ux/protocol";

export type EphemeralPiConversation = {
  id: string;
  title: string;
  events: readonly AgentUXEvent[];
  createdAt: number;
  /** The preset role that answered; restored with the conversation. */
  agentPreset?: string;
  /** Known from the server's store but its events are not loaded yet. */
  stored?: boolean;
  /** Host-reported active run; never an instruction to start or replay it. */
  activeRunId?: string;
  /** Group chat: a group's members and the last thing said in it. */
  groupMembers?: string[];
  groupPreview?: { author: string; text: string };
};

export type PiConversationSidebarItem = Pick<EphemeralPiConversation, "id" | "title" | "createdAt" | "agentPreset">;

export function createEphemeralPiConversation(
  id = createConversationId(),
  createdAt = Date.now(),
): EphemeralPiConversation {
  return { id, title: "New conversation", events: [], createdAt };
}

export function titlePiConversation(
  conversation: EphemeralPiConversation,
  prompt: string,
): EphemeralPiConversation {
  if (conversation.events.length > 0 || conversation.title !== "New conversation") return conversation;
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (!normalized) return conversation;
  return { ...conversation, title: normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized };
}

/** The events that end the run a conversation is following. */
const RUN_TERMINALS = new Set(["run.finished", "run.error"]);

/**
 * Pi starts event sequence numbers at one for every model turn. AgentUX sorts a combined stream by
 * sequence number, so each event appended to a browser conversation receives a conversation-wide
 * monotonic sequence while retaining its original event ID and run ID.
 *
 * `activeRunId` follows those events too. It is otherwise only a snapshot taken when the history
 * was read, so a finished run would keep naming itself and steering would address the wrong turn.
 */
export function appendPiConversationEvents(
  conversation: EphemeralPiConversation,
  incoming: readonly AgentUXEvent[],
): EphemeralPiConversation {
  if (incoming.length === 0) return conversation;
  const offset = conversation.events.length;
  const appended = incoming.map((event, index) => ({
    ...event,
    seq: offset + index + 1,
  })) as AgentUXEvent[];
  let activeRunId = conversation.activeRunId;
  for (const event of incoming) {
    if (event.type === "run.started" && event.runId) activeRunId = event.runId;
    else if (RUN_TERMINALS.has(event.type) && event.runId === activeRunId) activeRunId = undefined;
  }
  return { ...conversation, activeRunId, events: [...conversation.events, ...appended] };
}

export function replacePiConversation(
  conversations: readonly EphemeralPiConversation[],
  replacement: EphemeralPiConversation,
): readonly EphemeralPiConversation[] {
  return [replacement, ...conversations.filter((entry) => entry.id !== replacement.id)];
}

export function piConversationSidebarItems(
  conversations: readonly EphemeralPiConversation[],
): readonly PiConversationSidebarItem[] {
  return conversations.map(({ id, title, createdAt, agentPreset }) => ({ id, title, createdAt, agentPreset }));
}

function createConversationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `pi_${crypto.randomUUID()}`;
  }
  return `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
