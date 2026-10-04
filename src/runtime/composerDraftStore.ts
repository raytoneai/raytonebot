import type { ComposerDraft } from "../components/agent-preview/ComposerFrame";
import type { EphemeralPiConversation } from "../pi/piConversationState";
import type { QueuedMessage } from "./followUpQueue";

export type SavedComposerDraft = {
  id: string;
  conversation: Pick<EphemeralPiConversation, "id" | "title" | "createdAt" | "agentPreset">;
  draft: ComposerDraft;
  updatedAt: number;
  version: string;
  hasHistory: boolean;
  submission?: { requestId: string; prompt: string; attachmentIds: string[] };
  /** Follow-ups waiting in order. Only their content is kept: a reload restores them paused. */
  queue?: QueuedMessage[];
};

export const hasComposerDraft = (draft?: ComposerDraft) => Boolean(draft && (draft.prompt.length || draft.attachments.length));
export const hasComposerState = (draft?: ComposerDraft) => hasComposerDraft(draft) || Boolean(draft?.runOptions?.permissionMode || draft?.runOptions?.budgetMode);
export const hasSavedState = (record: Pick<SavedComposerDraft, "draft" | "queue">) => hasComposerState(record.draft) || Boolean(record.queue?.length);

/** Persist only explicit choices; malformed permissions must not broaden access. */
export function savedRunOptions(value: unknown): ComposerDraft["runOptions"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { permissionMode: "request" };
  const record = value as Record<string, unknown>, options: NonNullable<ComposerDraft["runOptions"]> = {};
  // Allow-all lives only in this page's memory: a reload falls back to the settings default
  // instead of silently re-arming unattended access.
  if (record.permissionMode !== undefined && record.permissionMode !== "allow-all") options.permissionMode = record.permissionMode === "auto" ? "auto" : "request";
  if (record.budgetMode !== undefined) options.budgetMode = record.budgetMode === "fast" || record.budgetMode === "expert" ? record.budgetMode : "medium";
  return Object.keys(options).length ? options : undefined;
}

const savedDraft = (draft: ComposerDraft): ComposerDraft => ({
  prompt: draft.prompt,
  runOptions: savedRunOptions(draft.runOptions),
  attachments: draft.attachments.map(({ id, file, reference, name, isImage }) => ({ id, name, isImage,
    ...(reference ? { reference: { scope: reference.scope, path: reference.path, name: reference.name } } : { file: file! }),
  })),
});

/** Only draft data crosses this boundary: never transcripts, provider settings or session keys. */
export function savedComposerDraft(conversation: EphemeralPiConversation, draft: ComposerDraft, submission?: SavedComposerDraft["submission"], queue?: readonly QueuedMessage[]): SavedComposerDraft {
  const { id, title, createdAt, agentPreset } = conversation;
  return { id, conversation: { id, title, createdAt, agentPreset }, draft: savedDraft(draft),
    updatedAt: Date.now(), version: crypto.randomUUID(), hasHistory: Boolean(conversation.stored || conversation.events.length), submission,
    ...(queue?.length ? { queue: queue.map((item) => ({ id: item.id, createdAt: item.createdAt, ...savedDraft(item) })) } : {}) };
}

export function acceptedComposerDraft(draft: ComposerDraft, submission: NonNullable<SavedComposerDraft["submission"]>): ComposerDraft {
  return {
    runOptions: draft.runOptions,
    prompt: draft.prompt === submission.prompt ? "" : draft.prompt,
    attachments: draft.attachments.filter((file) => !submission.attachmentIds.includes(file.id)),
  };
}

/** File uses the browser's structured clone, so restored attachments retain their real bytes. */
export function openComposerDraftStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("raytonebot-drafts", 1);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Draft storage unavailable")); }, 5000);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" });
    request.onerror = request.onblocked = () => { expired = true; clearTimeout(timer); reject(new Error("Draft storage unavailable")); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

const validDraft = (draft: ComposerDraft | undefined) => typeof draft?.prompt === "string" && Array.isArray(draft.attachments)
  && draft.attachments.every((attachment) => attachment.file instanceof File || (attachment.reference
    && ["assistant", "planner", "builder", "shared"].includes(attachment.reference.scope) && typeof attachment.reference.path === "string"));

export function readComposerDrafts(db: IDBDatabase): Promise<SavedComposerDraft[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").getAll();
    request.onsuccess = () => resolve(request.result.filter((record: SavedComposerDraft) =>
      typeof record?.id === "string" && record.conversation?.id === record.id
      && validDraft(record.draft) && Number.isFinite(record.updatedAt)).map((record: SavedComposerDraft) => {
        // A malformed item is dropped rather than sent with missing files or broader options.
        const queue = Array.isArray(record.queue) ? record.queue.filter((item) => typeof item?.id === "string" && validDraft(item))
          .map((item) => ({ ...item, createdAt: Number.isFinite(item.createdAt) ? item.createdAt : record.updatedAt, runOptions: savedRunOptions(item.runOptions) })) : [];
        const { queue: _stored, ...rest } = record;
        return { ...rest, draft: { ...record.draft, runOptions: savedRunOptions(record.draft.runOptions) }, ...(queue.length ? { queue } : {}) };
      }));
    request.onerror = () => reject(request.error);
  });
}

export function writeComposerDraft(db: IDBDatabase, record: SavedComposerDraft, previousVersion?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("drafts", "readwrite");
    const store = transaction.objectStore("drafts");
    const previous = store.get(record.id);
    let conflict = false;
    previous.onsuccess = () => {
      if (previous.result?.version !== previousVersion) { conflict = true; transaction.abort(); return; }
      if (hasSavedState(record)) store.put(record);
      else store.delete(record.id);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(conflict ? new Error("draft-conflict") : transaction.error);
  });
}
