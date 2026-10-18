import { useMemo, useRef, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { ComposerDraft } from "../components/agent-preview/ComposerFrame";
import type { EphemeralPiConversation } from "../pi/piConversationState";
import { branchStoredConversation, getStoredConversation, type PiPromptAttachment } from "../pi/piClient.ts";

export type BranchAction = "edit" | "regenerate" | "resend";

/** Read the original user message, never the assistant's rendered reply. */
export function resendMessage(events: readonly AgentUXEvent[], messageId: string) {
  const start = events.find(event => event.type === "text.started" && event.payload.textId === messageId && event.payload.role === "user");
  if (!start?.runId) return;
  const prompt = events.filter(event => event.runId === start.runId && event.type === "text.delta" && event.payload.textId === messageId)
    .map(event => typeof event.payload.delta === "string" ? event.payload.delta : "").join("");
  return prompt.trim() ? { prompt, runId: start.runId } : undefined;
}

/** Native adapters may reuse message IDs each turn; text IDs are already scoped by run. */
export function branchReplayEvents(events: readonly AgentUXEvent[]): AgentUXEvent[] {
  return events.map(event => event.type.startsWith("text.") && typeof event.payload.textId === "string"
    ? { ...event, messageId: event.payload.textId } : event);
}

export function branchMessageRuns(events: readonly AgentUXEvent[]): Map<string, string> {
  const runs = new Map<string, string>();
  for (const event of events) {
    if (event.type === "text.started" && event.runId && typeof event.payload.textId === "string"
      && !event.messageId?.startsWith(`${event.runId}_input_`)) runs.set(event.payload.textId, event.runId);
  }
  return runs;
}

export function branchComposerDraft(draft: { prompt: string; attachments?: PiPromptAttachment[] }): ComposerDraft {
  return { prompt: draft.prompt, attachments: (draft.attachments ?? []).map(reference => ({
    id: crypto.randomUUID(), reference, name: reference.name || reference.path.split("/").at(-1) || reference.path, isImage: false,
  })) };
}

export function useMessageBranch(input: {
  conversation: EphemeralPiConversation; enabled: boolean; running: boolean;
  submissions?: ReadonlyMap<string, ComposerDraft>;
  onResend?: (draft: ComposerDraft, sourceId: string) => Promise<void>;
  onReady: (conversation: EphemeralPiConversation, draft: ComposerDraft, action: BranchAction, sourceId: string) => Promise<void>;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const targets = useMemo(() => branchMessageRuns(input.conversation.events), [input.conversation.events]);
  return {
    canBranch: (messageId?: string) => Boolean(input.enabled && !input.running && !busy && messageId && targets.has(messageId)),
    async run(messageId: string, action: BranchAction) {
      const runId = targets.get(messageId);
      if (lock.current || !input.enabled || input.running || !runId) return;
      lock.current = true; setBusy(true);
      try {
        if (action === "resend") {
          const message = resendMessage(input.conversation.events, messageId);
          if (!message || !input.onResend) return;
          let draft = input.submissions?.get(runId);
          if (!draft) {
            const saved = await getStoredConversation(input.conversation.id);
            const turn = saved.turns?.find(turn => turn.runId === runId);
            draft = branchComposerDraft(turn ?? { prompt: message.prompt, attachments: [] });
          }
          await input.onResend(draft, input.conversation.id);
          return;
        }
        const result = await branchStoredConversation(input.conversation.id, runId);
        const saved = await getStoredConversation(result.conversationId);
        await input.onReady({ id: saved.id, title: saved.title, createdAt: saved.createdAt,
          agentPreset: saved.agentPreset, events: saved.events, stored: true }, branchComposerDraft(result.draft), action, input.conversation.id);
      } finally { lock.current = false; setBusy(false); }
    },
  };
}
