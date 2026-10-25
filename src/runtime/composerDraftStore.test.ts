import assert from "node:assert/strict";
import test from "node:test";
import { acceptedComposerDraft, hasComposerDraft, hasComposerState, hasSavedState, readComposerDrafts, savedComposerDraft, savedRunOptions } from "./composerDraftStore.ts";
import { enqueueDraft, nextQueueStep, queuedPrompt } from "./followUpQueue.ts";
import { branchComposerDraft } from "./useMessageBranch.ts";

test("explicit conversation options survive saving and message acceptance without capturing defaults or secrets", () => {
  const conversation = { id: "a", title: "A", createdAt: 1, events: [] };
  const runOptions = { permissionMode: "request" as const, budgetMode: "expert" as const, apiKey: "must-not-save" };
  const draft = { prompt: "Hello", attachments: [], runOptions };
  const saved = savedComposerDraft(conversation, draft);
  assert.deepEqual(saved.draft.runOptions, { permissionMode: "request", budgetMode: "expert" });
  const accepted = acceptedComposerDraft(saved.draft, { requestId: "run", prompt: "Hello", attachmentIds: [] });
  assert.equal(hasComposerDraft(accepted), false, "preferences alone never become a prompt");
  assert.equal(hasComposerState(accepted), true, "accepted empty drafts retain their preference record and revision");
  assert.deepEqual(accepted.runOptions, { permissionMode: "request", budgetMode: "expert" });
  assert.equal(savedComposerDraft(conversation, { prompt: "", attachments: [] }).draft.runOptions, undefined, "unchosen defaults remain live defaults");
});

test("old drafts follow defaults, while malformed persisted options cannot restore arbitrary permissions", () => {
  assert.equal(savedRunOptions(undefined), undefined);
  assert.equal(savedRunOptions({}), undefined);
  assert.deepEqual(savedRunOptions({ budgetMode: "fast", unrelated: "secret" }), { budgetMode: "fast" });
  assert.deepEqual(savedRunOptions({ permissionMode: "allow-all", budgetMode: "expert" }), { budgetMode: "expert" });
  assert.equal(savedRunOptions({ permissionMode: "allow-all" }), undefined);
  assert.deepEqual(savedRunOptions({ permissionMode: "auto" }), { permissionMode: "auto" });
  assert.deepEqual(savedRunOptions({ permissionMode: "administrator", budgetMode: "unlimited" }), { permissionMode: "request", budgetMode: "medium" });
  assert.deepEqual(savedRunOptions(["allow-all"]), { permissionMode: "request" });
  assert.equal(hasComposerState({ prompt: "", attachments: [] }), false);
});

test("accepted submissions clear only their own draft content and files; stored drafts exclude runtime secrets/events", async () => {
  const file = new File([new Uint8Array([0, 1, 255])], "input.bin");
  const attachment = { id: "first-file", file, name: file.name, isImage: false, imageSrc: "data:image/png;base64,unused" };
  const submission = { requestId: "request-a", prompt: "  First prompt  ", attachmentIds: [attachment.id] };
  const first = { prompt: submission.prompt, attachments: [attachment] };
  assert.equal(hasComposerDraft(acceptedComposerDraft(first, submission)), false);
  const added = { ...attachment, id: "later-file", file: new File(["new"], "later.txt") };
  const next = acceptedComposerDraft({ prompt: "Next draft", attachments: [attachment, added] }, submission);
  assert.equal(next.prompt, "Next draft");
  assert.deepEqual(next.attachments, [added]);
  const conversation = { id: "conversation", title: "Title", createdAt: 1, agentPreset: "planner", events: [], sessionKey: "must-not-be-saved" };
  const record = savedComposerDraft(conversation, first, submission);
  assert.deepEqual(Object.keys(record.conversation).sort(), ["agentPreset", "createdAt", "id", "title"]);
  assert.equal(record.draft.attachments[0].imageSrc, undefined);
  assert.deepEqual(new Uint8Array(await record.draft.attachments[0].file!.arrayBuffer()), new Uint8Array([0, 1, 255]));
  assert.equal(record.submission?.requestId, "request-a");
});

test("a new group's member-only draft survives, while empty accepted groups and single chats do not", () => {
  const conversation = { id: "group_new", title: "我、Bob", createdAt: 1, events: [], groupMembers: ["builder"] };
  const record = savedComposerDraft(conversation, { prompt: "", attachments: [] });
  assert.deepEqual(record.conversation.groupMembers, ["builder"]);
  assert.equal(hasSavedState(record), true);
  assert.equal(hasSavedState({ ...record, hasHistory: true }), false);
  assert.equal(hasSavedState(savedComposerDraft({ ...conversation, id: "solo", groupMembers: undefined }, record.draft)), false);
  assert.equal(hasSavedState(savedComposerDraft({ ...conversation, id: "pi_promoted" }, record.draft)), true, "promoted rooms keep their original conversation ID");
  assert.deepEqual(savedComposerDraft({ ...conversation, groupMembers: ["builder", "admin", "builder"] }, record.draft).conversation.groupMembers, ["builder"]);
});

function draftDatabase(records: unknown[]): IDBDatabase {
  return { transaction: () => ({ objectStore: () => ({ getAll() {
    const request: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => { request.result = records; request.onsuccess?.(); });
    return request;
  } }) }) } as unknown as IDBDatabase;
}

test("chat references persist as ids and titles across drafts, queues and acceptance without copying transcripts", async () => {
  const chat = { id: "ref-a", name: "Project review", isImage: false,
    chatReference: { conversationId: "saved:a", title: "Project review", transcript: "Must not be cached" } };
  const file = { id: "file-a", file: new File(["notes"], "notes.txt"), name: "notes.txt", isImage: false };
  const draft = { prompt: "Compare with this chat", attachments: [chat, file] };
  const { item, draft: cleared } = enqueueDraft(draft, { permissionMode: "request", budgetMode: "medium" }, "queued-a", 10);
  assert.deepEqual(cleared.attachments, []);
  assert.deepEqual(item.attachments, draft.attachments);
  assert.equal(queuedPrompt({ prompt: "", attachments: [chat] }), "Project review");
  const saved = savedComposerDraft({ id: "current", title: "Current", createdAt: 1, events: [] }, draft, undefined, [item]);
  const expected = { conversationId: "saved:a", title: "Project review" };
  assert.deepEqual(saved.draft.attachments[0].chatReference, expected);
  assert.deepEqual(saved.queue?.[0].attachments[0].chatReference, expected);
  assert.equal(saved.draft.attachments[0].file, undefined);
  assert.equal(JSON.stringify(saved).includes("Must not be cached"), false);
  const [restored] = await readComposerDrafts(draftDatabase([saved]));
  assert.deepEqual(restored.draft.attachments[0].chatReference, expected);
  assert.deepEqual(restored.queue?.[0].attachments[0].chatReference, expected);
  assert.equal(nextQueueStep({ items: restored.queue!, paused: "restored" }, { running: false, events: [], connectionFailed: false }).kind, "wait");
  const late = { ...chat, id: "ref-later", chatReference: { conversationId: "saved:later", title: "Later" } };
  const accepted = acceptedComposerDraft({ prompt: draft.prompt, attachments: [chat, late] }, { requestId: "run-a", prompt: draft.prompt, attachmentIds: [chat.id] });
  assert.deepEqual(accepted.attachments, [late], "late additions are not consumed by an earlier acceptance");
});

test("restoring chat-reference drafts rejects invalid ids, mixed attachment kinds, duplicates and more than five", async () => {
  const chat = { id: "ref-a", name: "Previous", isImage: false, chatReference: { conversationId: "saved:a", title: "Previous" } };
  const base = savedComposerDraft({ id: "current", title: "Current", createdAt: 1, events: [] }, { prompt: "Use this", attachments: [chat] });
  const invalid = [
    [{ ...chat, chatReference: { ...chat.chatReference, conversationId: "../escape" } }],
    [{ ...chat, chatReference: { ...chat.chatReference, conversationId: ".." } }],
    [{ ...chat, chatReference: { conversationId: "saved:a" } }],
    [{ ...chat, chatReference: { ...chat.chatReference, title: "x".repeat(501) } }],
    [{ ...chat, reference: { scope: "shared", path: "other.txt" } }],
    [{ ...chat, file: new File(["mixed"], "mixed.txt") }],
    [{ ...chat, isImage: true }], [chat, { ...chat, id: "duplicate" }],
    Array.from({ length: 6 }, (_, index) => ({ ...chat, id: `ref-${index}`, chatReference: { conversationId: `saved:${index}`, title: "Previous" } })),
  ];
  for (const attachments of invalid) {
    assert.deepEqual(await readComposerDrafts(draftDatabase([{ ...base, draft: { prompt: "Bad", attachments } }])), []);
  }
  const [restored] = await readComposerDrafts(draftDatabase([{ ...base, queue: [
    { id: "valid", createdAt: 1, prompt: "Valid", attachments: [chat] },
    ...invalid.map((attachments, index) => ({ id: `invalid-${index}`, createdAt: 1, prompt: "Bad", attachments })),
  ] }]));
  assert.deepEqual(restored.queue?.map(item => item.id), ["valid"], "malformed queued references never become missing or broader context");
});

test("branch and resend drafts recover conversation references alongside workspace files", () => {
  const draft = branchComposerDraft({ prompt: "Original request", attachments: [{ scope: "shared", path: "notes.txt" }], referencedConversationIds: ["saved:a", "saved:b"] });
  assert.equal(draft.attachments.length, 3);
  assert.deepEqual(draft.attachments[0].reference, { scope: "shared", path: "notes.txt" });
  assert.deepEqual(draft.attachments.slice(1).map(item => item.chatReference), [
    { conversationId: "saved:a", title: "saved:a" }, { conversationId: "saved:b", title: "saved:b" },
  ]);
  assert.equal(new Set(draft.attachments.map(item => item.id)).size, 3);
  assert.ok(draft.attachments.every(item => !item.isImage));
});
