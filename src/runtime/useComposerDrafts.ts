import { useEffect, useRef, useState } from "react";
import type { ComposerDraft, ComposerRunOptions } from "../components/agent-preview/ComposerFrame";
import type { EphemeralPiConversation } from "../pi/piConversationState";
import { acceptedComposerDraft, hasComposerDraft, hasSavedState, openComposerDraftStore, readComposerDrafts, savedComposerDraft, writeComposerDraft, type SavedComposerDraft } from "./composerDraftStore";
import { enqueueDraft, withoutAccepted, type FollowUpQueue, type QueuePause } from "./followUpQueue";

const emptyDraft = (): ComposerDraft => ({ prompt: "", attachments: [] });
type DraftStatus = "loading" | "saving" | "saved" | "unavailable" | "conflict";

export function useComposerDrafts() {
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [restored, setRestored] = useState<SavedComposerDraft[]>([]);
  const [status, setStatus] = useState<DraftStatus>("loading");
  const [statuses, setStatuses] = useState<Record<string, DraftStatus>>({});
  const current = useRef(drafts);
  const [queues, setQueues] = useState<Record<string, FollowUpQueue>>({});
  const currentQueues = useRef(queues);
  const touched = useRef(new Set<string>());
  const database = useRef<Promise<IDBDatabase> | undefined>(undefined);
  const writes = useRef(Promise.resolve());
  const revisions = useRef(new Map<string, string>());
  const submissions = useRef(new Map<string, NonNullable<SavedComposerDraft["submission"]>>());
  const versions = useRef(new Map<string, string>());
  const withHistory = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    const opening = openComposerDraftStore();
    database.current = opening;
    void opening.then(readComposerDrafts).then((records) => {
      if (!active) return;
      for (const record of records) {
        versions.current.set(record.id, record.version);
        if (record.hasHistory) withHistory.current.add(record.id);
      }
      const recovered = records.filter((record) => !touched.current.has(record.id));
      for (const record of recovered) if (record.submission) submissions.current.set(record.id, record.submission);
      current.current = { ...Object.fromEntries(recovered.map((record) => [record.id, record.draft])), ...current.current };
      setDrafts(current.current);
      // Whether a restored follow-up already reached the host is unknown until checked: never auto-send.
      currentQueues.current = { ...Object.fromEntries(recovered.flatMap((record) => record.queue?.length
        ? [[record.id, { items: record.queue, paused: "restored" as const }]] : [])), ...currentQueues.current };
      setQueues(currentQueues.current);
      // Preferences on completed histories must not masquerade as drafts or steal navigation;
      // paused follow-ups do need the user, so they lead back to their conversation.
      setRestored(recovered.filter(record => hasComposerDraft(record.draft) || !record.hasHistory || record.submission || record.queue?.length)
        .sort((a, b) => b.updatedAt - a.updatedAt));
      setStatus("saved");
    }).catch(() => { if (active) setStatus("unavailable"); });
    return () => { active = false; void writes.current.finally(() => opening.then((db) => db.close()).catch(() => undefined)); };
  }, []);

  function setQueue(id: string, queue: FollowUpQueue) {
    // An emptied queue forgets its pause, so the next follow-up is not held by an old stop.
    currentQueues.current = { ...currentQueues.current, [id]: queue.items.length ? queue : { items: [] } };
    setQueues(currentQueues.current);
  }

  function update(conversation: EphemeralPiConversation, change: (draft: ComposerDraft) => ComposerDraft, changeQueue?: (queue: FollowUpQueue) => FollowUpQueue) {
    const draft = change(current.current[conversation.id] ?? emptyDraft());
    touched.current.add(conversation.id);
    current.current = { ...current.current, [conversation.id]: draft };
    setDrafts(current.current);
    if (changeQueue) setQueue(conversation.id, changeQueue(currentQueues.current[conversation.id] ?? { items: [] }));
    // Draft and queue share one record, so moving text into the queue is a single write.
    const record = savedComposerDraft(conversation, draft, submissions.current.get(conversation.id), currentQueues.current[conversation.id]?.items);
    if (record.hasHistory) withHistory.current.add(record.id);
    record.hasHistory ||= withHistory.current.has(record.id);
    revisions.current.set(record.id, record.version);
    const report = (value: DraftStatus) => {
      if (revisions.current.get(record.id) === record.version) setStatuses((current) => ({ ...current, [record.id]: value }));
    };
    report("saving");
    // Transactions are ordered; a late earlier save cannot resurrect an accepted/deleted draft.
    writes.current = writes.current.then(async () => {
      const db = await database.current;
      if (!db) throw new Error("Draft storage unavailable");
      await writeComposerDraft(db, record, versions.current.get(record.id));
      if (hasSavedState(record)) versions.current.set(record.id, record.version);
      else versions.current.delete(record.id);
      report("saved");
    }).catch((error) => report(error?.message === "draft-conflict" ? "conflict" : "unavailable"));
    return writes.current;
  }

  function submitted(conversation: EphemeralPiConversation, submission: NonNullable<SavedComposerDraft["submission"]>) {
    submissions.current.set(conversation.id, submission);
    return update(conversation, (draft) => draft);
  }

  function accepted(conversation: EphemeralPiConversation, requestIds: Set<string>) {
    const submission = submissions.current.get(conversation.id);
    if (!submission || !requestIds.has(submission.requestId)) return;
    submissions.current.delete(conversation.id);
    void update(conversation, (draft) => acceptedComposerDraft(draft, submission));
  }

  /** Moves the conversation's draft text and files to the end of its queue. */
  function enqueue(conversation: EphemeralPiConversation, options: ComposerRunOptions) {
    const draft = current.current[conversation.id] ?? emptyDraft();
    if (!hasComposerDraft(draft)) return;
    const { item, draft: rest } = enqueueDraft(draft, options, "pi_export_" + crypto.randomUUID());
    return update(conversation, () => rest, (queue) => ({ ...queue, items: [...queue.items, item] }));
  }

  const removeQueued = (conversation: EphemeralPiConversation, ids: ReadonlySet<string>) => {
    const queue = currentQueues.current[conversation.id];
    if (!queue || withoutAccepted(queue, ids) === queue) return;
    return update(conversation, (draft) => draft, (current) => withoutAccepted(current, ids));
  };

  /** Back into an empty composer for editing; a draft in progress is never overwritten. */
  function editQueued(conversation: EphemeralPiConversation, id: string) {
    const item = currentQueues.current[conversation.id]?.items.find((entry) => entry.id === id);
    if (!item || hasComposerDraft(current.current[conversation.id])) return;
    return update(conversation, (draft) => ({ prompt: item.prompt, attachments: item.attachments, runOptions: draft.runOptions }),
      (queue) => withoutAccepted(queue, new Set([id])));
  }

  // Pausing is this page's state; a reload restores every queue paused anyway.
  const pauseQueue = (id: string, reason: QueuePause) => {
    const queue = currentQueues.current[id];
    if (queue?.items.length && !queue.paused) setQueue(id, { ...queue, paused: reason });
  };
  const resumeQueue = (id: string, settledRunId?: string) => {
    const queue = currentQueues.current[id];
    if (queue?.items.length) setQueue(id, { items: queue.items, settledRunId });
  };

  return { drafts, queues, restored, statusFor: (id: string) => statuses[id] ?? status, update, submitted, accepted,
    enqueue, removeQueued, editQueued, pauseQueue, resumeQueue };
}
