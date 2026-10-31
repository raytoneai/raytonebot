import type { AgentUXEvent } from "@agent-ux/protocol";
import { appendPiConversationEvents, type EphemeralPiConversation } from "../pi/piConversationState.ts";
import { createPiFrameCommit, type PiFrameCommit } from "../pi/piFrameCommit.ts";
import { groupFields } from "./groupConversationView.ts";
import { applyPendingConversationWait, pendingConversationWaits } from "./pendingConversationWait.ts";

export type ConversationStreamOptions = {
  /** The owner may disappear while a requestAnimationFrame callback is queued. */
  isCurrent: () => boolean;
  /** Apply one coalesced or authoritative conversation snapshot to the shell. */
  commit: (conversation: EphemeralPiConversation) => void;
  /** Called for canonical wait/settlement events with the current waiting state. */
  onAwaiting?: (awaiting: boolean) => void;
};

export type ConversationStream = {
  readonly current: EphemeralPiConversation;
  append(event: AgentUXEvent): void;
  /** Cancel a queued frame before replacing it with the host's authoritative snapshot. */
  replace(conversation: EphemeralPiConversation): void;
  flush(): void;
  cancel(): void;
};

/** Owns the shared snapshot/frame/wait bookkeeping for one conversation stream. */
export function createConversationStream(
  initial: EphemeralPiConversation,
  options: ConversationStreamOptions,
): ConversationStream {
  let current = initial;
  let waits = pendingConversationWaits(initial.events);

  const frame: PiFrameCommit<EphemeralPiConversation> = createPiFrameCommit((conversation) => {
    if (options.isCurrent()) options.commit(conversation);
  });
  return {
    get current() { return current; },
    append(event) {
      if (event.type === "group.members.updated") current = { ...current, ...groupFields(event.payload) };
      current = appendPiConversationEvents(current, [event]);
      const waitUpdate = applyPendingConversationWait(waits, event);
      frame.push(current);
      // A newly announced wait must be visible without waiting for the next animation frame.
      if (waitUpdate === "announced") frame.flush();
      if (waitUpdate && options.isCurrent()) options.onAwaiting?.(waits.size > 0);
    },
    replace(conversation) {
      frame.cancel();
      current = conversation;
      waits = pendingConversationWaits(conversation.events);
      if (options.isCurrent()) {
        options.commit(current);
        options.onAwaiting?.(waits.size > 0);
      }
    },
    flush() { frame.flush(); },
    cancel() { frame.cancel(); },
  };
}
