import { useLayoutEffect, useMemo, useReducer } from "react";
import type { ComponentProps } from "react";
import type { InlineApprovalPrompt } from "../components/agent-preview/chatframe/approval";
import { vaultCopy } from "../i18n/copy/vault";
import { vaultRequestCopy, vaultResultMessage } from "../i18n/copy/vaultRequest";
import type { AppLocale } from "../i18n/locales";
import { answerVaultRequest } from "../pi/piClient";
import type { VaultRequestView } from "../pi/vaultRequestTypes";
import { createVaultRequestDraft } from "./vaultRequest";

export function useVaultRequest(request: VaultRequestView | undefined, conversationId: string, locale: AppLocale): ComponentProps<typeof InlineApprovalPrompt> | undefined {
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const form = useMemo(() => request ? createVaultRequestDraft(request) : undefined, [conversationId, request?.requestId, request?.runId]);
  useLayoutEffect(() => {
    if (!form || !request) return;
    form.listen(redraw);
    const expiry = setTimeout(() => form.expire(), Math.max(0, request.expiresAt - Date.now()));
    return () => { clearTimeout(expiry); form.dispose(); };
  }, [form]);
  if (!request || !form || form.state.dismissed) return undefined;
  const copy = vaultRequestCopy[locale], labels = vaultCopy[locale], draft = form.state;
  const send = (cancel: boolean) => void form.submit(cancel, (answer) => answerVaultRequest(conversationId, request.requestId, request.runId, answer));
  const base = { ariaLabel: copy.title, kicker: copy.title, question: copy.question(request.origin), form: true };
  if (draft.result) return {
    ...base, options: [], primaryLabel: copy.close, onPrimary: () => form.dismiss(),
    hint: vaultResultMessage(locale, draft.result),
  };
  return {
    ...base, singleChoice: true, pending: draft.pending,
    options: request.items.length ? [...request.items, { id: "", label: copy.other }].map((item) => ({
      id: item.id, title: item.label, selected: draft.selected === item.id,
      onSelect: () => form.edit({ selected: item.id, username: "", password: "", save: false, label: "" }),
    })) : [],
    fields: draft.selected ? [] : [
      { id: "username", label: labels.username, secret: true, maxLength: 512, value: draft.username, onChange: (username: string) => form.edit({ username }) },
      { id: "password", label: labels.password, secret: true, maxLength: 8192, value: draft.password, onChange: (password: string) => form.edit({ password }) },
      ...(draft.save ? [{ id: "label", label: labels.label, maxLength: 120, value: draft.label, onChange: (label: string) => form.edit({ label }) }] : []),
    ],
    checkbox: draft.selected ? undefined : { label: copy.save, checked: draft.save, onChange: (save: boolean) => form.edit({ save, ...(!save ? { label: "" } : {}) }) },
    hint: draft.failed ? copy.failed : copy.hint,
    secondaryLabel: labels.cancel, onSecondary: () => send(true), primaryLabel: draft.pending ? copy.filling : copy.fill,
    primaryDisabled: !draft.selected && (!draft.username.length || !draft.password.length), onPrimary: () => send(false),
  };
}
