import type { PendingUserInput } from "./userInput.ts";

export type UserInputDraft = { index: number; choices: Record<string, string[]>; other: Record<string, string> };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): DraftStorage => sessionStorage;
const key = (conversationId: string) => `raytonebot-question-draft:${conversationId}`;
export const emptyUserInputDraft = (): UserInputDraft => ({ index: 0, choices: {}, other: {} });

/** Per-tab recovery only. Stored data never initiates an answer or a run. */
export function readUserInputDraft(conversationId: string, request: PendingUserInput, getStorage = storage): { draft: UserInputDraft; saved?: boolean } {
  try {
    const raw = getStorage().getItem(key(conversationId));
    if (!raw) return { draft: emptyUserInputDraft() };
    if (raw.length > 262144) throw new Error("Invalid answer draft");
    const record = JSON.parse(raw);
    if (record.requestId !== request.requestId) return { draft: emptyUserInputDraft() };
    const { index, choices, other } = record.draft;
    if (!Number.isInteger(index) || index < 0 || index >= request.questions.length) throw new Error("Invalid question index");
    const entries = request.questions.map((q) => {
      const selected = Object.hasOwn(choices, q.id) ? choices[q.id] : [];
      const text = Object.hasOwn(other, q.id) ? other[q.id] : "";
      if (!Array.isArray(selected) || selected.length > (q.multiSelect ? q.options.length : 1)
        || new Set(selected).size !== selected.length || selected.some((v) => !q.options.some((o) => o.label === v))
        || typeof text !== "string" || text.length > 4000 || (!q.allowOther && text)
        || (!q.multiSelect && selected.length && text)) throw new Error("Invalid answer draft");
      return { id: q.id, selected, text };
    });
    // Ignore transient pending/done/error flags and unknown question fields.
    return { draft: { index, choices: Object.fromEntries(entries.map((q) => [q.id, q.selected])),
      other: Object.fromEntries(entries.map((q) => [q.id, q.text])) }, saved: true };
  } catch { return { draft: emptyUserInputDraft(), saved: false }; }
}

export function writeUserInputDraft(conversationId: string, requestId: string, draft: UserInputDraft, getStorage = storage): boolean {
  try {
    const { index, choices, other } = draft;
    getStorage().setItem(key(conversationId), JSON.stringify({ requestId, draft: { index, choices, other } }));
    return true;
  } catch { return false; }
}

export function clearUserInputDraft(conversationId: string, requestId: string, getStorage = storage): void {
  try {
    const store = getStorage();
    const raw = store.getItem(key(conversationId));
    // A delayed acknowledgement must not remove the next question's draft.
    if (raw && JSON.parse(raw).requestId === requestId) store.removeItem(key(conversationId));
  } catch { /* Unavailable storage cannot prevent answering or stopping. */ }
}
