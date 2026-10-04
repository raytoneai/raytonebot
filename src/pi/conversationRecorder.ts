import type { AgentUXEvent } from "@agent-ux/protocol";
import type { ConversationStore } from "./conversationStore.ts";
import { piErrorTurnEvents, PROMPT_REJECTED } from "./piErrorTurn.ts";

/** One turn's persistence boundary. Streaming deltas may be buffered; receipts may not. */
export function createConversationRecorder(input: {
  store: ConversationStore;
  conversationId: string;
  runId?: string;
  broadcast(event: AgentUXEvent): void;
  stop(): void;
}) {
  let unflushed = 0;
  let terminalRecorded = false;
  let promptTextId: string | undefined;
  let promptSaved = false;
  let runId = input.runId;
  let failure: string | undefined;
  const flush = () => {
    try { input.store.flush(input.conversationId); } catch (error) {
      failure = error instanceof Error ? error.message : "Conversation could not be saved.";
      // A callback from the adapter must not stop that adapter recursively.
      queueMicrotask(input.stop);
      throw error;
    }
    unflushed = 0;
  };
  return {
    get failed() { return failure !== undefined; },
    get ended() { return terminalRecorded || failure !== undefined; },
    record(event: AgentUXEvent) {
      if (terminalRecorded || failure) return;
      runId ??= event.runId;
      const terminal = event.type === "run.finished" || event.type === "run.error";
      input.store.append(input.conversationId, event);
      unflushed++;
      if (!promptTextId && event.type === "text.started" && event.payload.role === "user") promptTextId = event.payload.textId;
      const promptFinished = event.type === "text.finished" && event.payload.textId === promptTextId;
      if (terminal || promptFinished || unflushed >= 40 || event.type === "tool.call.awaiting_approval" || event.type === "run.awaiting_input" || event.payload.inputRequestId) {
        flush();
        if (promptFinished) promptSaved = true;
      }
      if (terminal) terminalRecorded = true;
      input.broadcast(event);
    },
    finish() {
      if (unflushed > 0 && !failure) {
        try { flush(); } catch { /* flush captured the failure; report it below. */ }
      }
      if (!failure) return true;
      // A failed disk cannot save its own error. Report it to every attached reader, without
      // claiming the task succeeded or that an already accepted prompt never started.
      for (const event of piErrorTurnEvents({ runId,
        code: promptSaved ? "history_save_failed" : PROMPT_REJECTED,
        message: failure + (promptSaved ? " The task may already have changed files. Check its results before retrying." : " The prompt was not started."),
      })) input.broadcast(event);
      return false;
    },
  };
}
