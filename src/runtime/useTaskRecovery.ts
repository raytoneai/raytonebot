import type { AppLocale } from "../i18n/locales.ts";
import { featureText } from "../i18n/copy/features.ts";
import { useRef, useState } from "react";
import type { ComposerDraft } from "../components/agent-preview/ComposerFrame";
import type { EphemeralPiConversation } from "../pi/piConversationState";
import { getStoredConversation, PiRequestError } from "../pi/piClient.ts";
import { branchComposerDraft } from "./useMessageBranch.ts";
import { recoveryDestinationLabel, recoveryPrompt, taskRecovery, type RecoveryDestination } from "./taskRecovery.ts";

export type TaskRecoveryActions = {
  id: string; message: string; configureLabel: string; continueLabel: string; busy: boolean; ready: boolean;
  configure(): void; resume(): Promise<void>; error?: string;
};

export function useTaskRecovery(input: {
  conversation: EphemeralPiConversation; enabled: boolean; running: boolean; locale: AppLocale;
  submissions: ReadonlyMap<string, ComposerDraft>;
  isCurrent(id: string): boolean;
  configure(destination: RecoveryDestination): void;
  submit(draft: ComposerDraft, conversation: EphemeralPiConversation, requestId: string): Promise<void>;
}): TaskRecoveryActions | undefined {
  const target = input.enabled ? taskRecovery(input.conversation.events) : undefined;
  const key = target ? `${input.conversation.id}:${target.id}` : undefined;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [visited, setVisited] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  if (!target || !key) return;
  const locale = input.locale;
  return {
    id: key, ready: visited === key, busy: busy || input.running,
    message: featureText(locale, "Check the connection or configuration, then continue with the original request and attachments."),
    configureLabel: recoveryDestinationLabel(target.destination, locale), continueLabel: featureText(locale, "Continue task"),
    error: failure?.key === key ? failure.message : undefined,
    configure() { setVisited(key); setFailure(undefined); input.configure(target.destination); },
    async resume() {
      if (lock.current || input.running || visited !== key || !input.isCurrent(input.conversation.id)) return;
      lock.current = true; setBusy(true); setFailure(undefined);
      try {
        let saved: Awaited<ReturnType<typeof getStoredConversation>> | undefined;
        const local = input.submissions.get(target.runId);
        try { saved = await getStoredConversation(input.conversation.id); }
        catch (error) { if (!(local && error instanceof PiRequestError && error.status === 404)) throw error; }
        if (currentKey.current !== key || !input.isCurrent(input.conversation.id)) return;
        if (saved?.activeRunId || saved?.incomplete) throw new Error(featureText(locale, "The host run is active or unconfirmed. Reopen this conversation to check it first."));
        const turn = saved?.turns?.find(turn => turn.runId === target.runId);
        const latestRun = saved?.events.at(-1)?.runId;
        if (latestRun && latestRun !== target.runId && !input.conversation.events.some(event => event.runId === latestRun)) {
          throw new Error(featureText(locale, "This task has newer work. Reopen the conversation to review it."));
        }
        const original = turn ? branchComposerDraft(turn) : local;
        if (!original) throw new Error(featureText(locale, "The original request or attachments are unavailable. Reopen the conversation and retry."));
        // Same recovery from two tabs uses one host request identity; never reuse the failed run id.
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.conversation.id}:${target.runId}`));
        const requestId = `continue_${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
        if (currentKey.current !== key || !input.isCurrent(input.conversation.id)) return;
        const conversation = saved ? { ...input.conversation, events: saved.events, activeRunId: saved.activeRunId } : input.conversation;
        await input.submit({ ...original, prompt: recoveryPrompt(original.prompt, Boolean(turn), locale) }, conversation, requestId);
      } catch (error) {
        setFailure({ key, message: error instanceof Error ? error.message : String(error) });
      } finally { lock.current = false; setBusy(false); }
    },
  };
}
