import { useEffect, useRef, useState } from "react";
import type { ComposerDraft } from "../components/agent-preview/ComposerFrame";
import type { EphemeralPiConversation } from "../pi/piConversationState";
import { acceptedComposerDraft, hasComposerDraft, hasComposerState, openComposerDraftStore, readComposerDrafts, savedComposerDraft, writeComposerDraft, type SavedComposerDraft } from "./composerDraftStore";

const emptyDraft = (): ComposerDraft => ({ prompt: "", attachments: [] });
type DraftStatus = "loading" | "saving" | "saved" | "unavailable" | "conflict";

export function useComposerDrafts() {
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [restored, setRestored] = useState<SavedComposerDraft[]>([]);
  const [status, setStatus] = useState<DraftStatus>("loading");
  const [statuses, setStatuses] = useState<Record<string, DraftStatus>>({});
  const current = useRef(drafts);
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
      // Preferences on completed histories must not masquerade as drafts or steal navigation.
      setRestored(recovered.filter(record => hasComposerDraft(record.draft) || !record.hasHistory || record.submission).sort((a, b) => b.updatedAt - a.updatedAt));
      setStatus("saved");
    }).catch(() => { if (active) setStatus("unavailable"); });
    return () => { active = false; void writes.current.finally(() => opening.then((db) => db.close()).catch(() => undefined)); };
  }, []);

  function update(conversation: EphemeralPiConversation, change: (draft: ComposerDraft) => ComposerDraft) {
    const draft = change(current.current[conversation.id] ?? emptyDraft());
    touched.current.add(conversation.id);
    current.current = { ...current.current, [conversation.id]: draft };
    setDrafts(current.current);
    const record = savedComposerDraft(conversation, draft, submissions.current.get(conversation.id));
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
      if (hasComposerState(record.draft)) versions.current.set(record.id, record.version);
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

  return { drafts, restored, statusFor: (id: string) => statuses[id] ?? status, update, submitted, accepted };
}
