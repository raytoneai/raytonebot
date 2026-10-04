import type { ComposerDraft, ComposerRunOptions } from "../components/agent-preview/ComposerFrame";
import type { AgentUXEvent } from "@agent-ux/protocol";

/** A follow-up waiting for the current turn. Its id is the requestId it will be sent with, so
 *  the host rejects a second submission and a reload can check whether it was already accepted. */
export type QueuedMessage = Pick<ComposerDraft, "prompt" | "attachments" | "runOptions"> & { id: string; createdAt: number };
/** Why sending stopped; only the user resumes. A reload always restores a queue as paused. */
export type QueuePause = "stopped" | "failed" | "restored";
export type FollowUpQueue = {
  items: QueuedMessage[];
  paused?: QueuePause;
  /** The terminal the user resumed past; it must not pause the queue a second time. */
  settledRunId?: string;
};

export type QueueStep = { kind: "wait" } | { kind: "pause"; reason: QueuePause } | { kind: "send"; item: QueuedMessage };

export const queuedPrompt = (item: Pick<QueuedMessage, "prompt" | "attachments">) =>
  item.prompt.trim() || item.attachments.map((file) => file.name).join(", ");

/** Moves the draft's text and files into a new queue item; the conversation's options stay. */
export function enqueueDraft(draft: ComposerDraft, options: ComposerRunOptions, id: string, now = Date.now()) {
  const item: QueuedMessage = { id, createdAt: now, prompt: draft.prompt, attachments: draft.attachments, runOptions: { ...options } };
  return { item, draft: { prompt: "", attachments: [], runOptions: draft.runOptions } satisfies ComposerDraft };
}

export function lastRunOutcome(events: readonly AgentUXEvent[]): { runId?: string; status: "success" | "cancelled" | "error" } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "run.error") return { runId: event.runId, status: "error" };
    if (event.type === "run.finished") {
      const status = String((event.payload as { status?: string }).status ?? "success");
      return { runId: event.runId, status: status === "success" ? "success" : status === "cancelled" ? "cancelled" : "error" };
    }
  }
  return undefined;
}

/** Sends only after a turn that ended well; a stop, failure or lost connection pauses instead. */
export function nextQueueStep(queue: FollowUpQueue | undefined, state: { running: boolean; events: readonly AgentUXEvent[]; connectionFailed: boolean }): QueueStep {
  if (!queue?.items.length || queue.paused || state.running) return { kind: "wait" };
  if (state.connectionFailed) return { kind: "pause", reason: "failed" };
  const outcome = lastRunOutcome(state.events);
  if (outcome && outcome.status !== "success" && outcome.runId !== queue.settledRunId) {
    return { kind: "pause", reason: outcome.status === "cancelled" ? "stopped" : "failed" };
  }
  return { kind: "send", item: queue.items[0] };
}

/** Items the host already holds a turn for were sent before; they must never be sent again. */
export function withoutAccepted(queue: FollowUpQueue, acceptedRunIds: ReadonlySet<string>): FollowUpQueue {
  const items = queue.items.filter((item) => !acceptedRunIds.has(item.id));
  return items.length === queue.items.length ? queue : { ...queue, items };
}
