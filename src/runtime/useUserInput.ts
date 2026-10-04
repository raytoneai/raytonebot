import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { InlineApprovalPrompt } from "../components/agent-preview/chatframe/approval";
import { questionCopy } from "../i18n/copy/questions";
import type { AppLocale } from "../i18n/locales";
import { answerPiQuestion, PiRequestError } from "../pi/piClient";
import type { PendingUserInput, UserAnswers } from "./userInput";
import { clearUserInputDraft, emptyUserInputDraft, readUserInputDraft, writeUserInputDraft, type UserInputDraft } from "./userInputDraft";

type Draft = UserInputDraft & { pending?: boolean; error?: string; done?: boolean; saved?: boolean };

/** Form state belongs to the shell so opening Output does not erase a partial answer. */
export function useUserInput(request: PendingUserInput | undefined, conversationId: string, locale: AppLocale): ComponentProps<typeof InlineApprovalPrompt> | undefined {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const current = useRef(drafts);
  const sending = useRef(new Set<string>());
  const previous = useRef<{ conversationId: string; requestId: string } | undefined>(undefined);
  const restored = useMemo(() => request ? readUserInputDraft(conversationId, request) : undefined, [conversationId, request?.requestId]);
  useEffect(() => {
    const prior = previous.current;
    if (prior?.conversationId === conversationId && prior.requestId !== request?.requestId) clearUserInputDraft(conversationId, prior.requestId);
    previous.current = request ? { conversationId, requestId: request.requestId } : undefined;
  }, [conversationId, request?.requestId]);
  if (!request) return undefined;
  const { requestId, questions } = request;
  const scope = JSON.stringify([conversationId, requestId]);
  const draft = drafts[scope] ?? { ...(restored?.draft ?? emptyUserInputDraft()), saved: restored?.saved };
  if (draft.done) return undefined;
  const copy = questionCopy[locale];
  const question = questions[draft.index];
  const selected = draft.choices[question.id] ?? [];
  const other = draft.other[question.id] ?? "";
  const update = (change: Partial<Draft>) => {
    const next = { ...(current.current[scope] ?? draft), ...change };
    if (change.index !== undefined || change.choices || change.other) next.saved = writeUserInputDraft(conversationId, requestId, next);
    current.current = { ...current.current, [scope]: next };
    setDrafts(current.current);
  };
  const send = async (answers: UserAnswers) => {
    if (sending.current.has(requestId)) return;
    sending.current.add(requestId);
    update({ pending: true, error: undefined });
    try {
      await answerPiQuestion(conversationId, requestId, answers);
      clearUserInputDraft(conversationId, requestId);
      update({ done: true });
    } catch (error) {
      update({ error: error instanceof PiRequestError && error.status === 409 ? copy.stale : copy.failed });
    } finally {
      sending.current.delete(requestId);
      update({ pending: false });
    }
  };
  return {
    ariaLabel: copy.title, kicker: `${copy.title} · ${draft.index + 1}/${questions.length} · ${question.header}`,
    question: question.question, pending: draft.pending,
    hint: draft.error ?? [question.multiSelect ? copy.multiple : copy.single,
      draft.saved === false ? copy.draftFailed : draft.saved ? copy.draftSaved : ""].filter(Boolean).join(" "),
    options: [
      ...question.options.map((option, index) => ({ id: `${question.id}_${index}`,
        title: `${selected.includes(option.label) ? "✓ " : ""}${option.label}`, body: option.description,
        selected: selected.includes(option.label), onSelect: () => {
          const choices = question.multiSelect
            ? selected.includes(option.label) ? selected.filter((v) => v !== option.label) : [...selected, option.label]
            : [option.label];
          update({ choices: { ...draft.choices, [question.id]: choices },
            ...(!question.multiSelect ? { other: { ...draft.other, [question.id]: "" } } : {}), error: undefined });
        } })),
      ...(question.allowOther ? [{ id: `${question.id}_other`, title: copy.other, answerPlaceholder: true }] : []),
    ],
    answer: other, onAnswerChange: (answer) => update({ other: { ...draft.other, [question.id]: answer },
      ...(!question.multiSelect ? { choices: { ...draft.choices, [question.id]: [] } } : {}), error: undefined }),
    secondaryLabel: draft.index ? copy.back : copy.skip,
    onSecondary: () => { if (draft.index) update({ index: draft.index - 1, error: undefined }); else void send(null); },
    primaryLabel: draft.pending ? copy.sending : draft.index === questions.length - 1 ? copy.send : copy.next,
    primaryDisabled: !selected.length && !other.trim(),
    onPrimary: () => {
      if (draft.index < questions.length - 1) update({ index: draft.index + 1, error: undefined });
      else void send(Object.fromEntries(questions.map((q) => [q.id, [...new Set([
        ...(draft.choices[q.id] ?? []), ...(draft.other[q.id]?.trim() ? [draft.other[q.id].trim()] : []),
      ])]])));
    },
  };
}
