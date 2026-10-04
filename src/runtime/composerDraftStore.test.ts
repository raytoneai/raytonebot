import assert from "node:assert/strict";
import test from "node:test";
import { acceptedComposerDraft, hasComposerDraft, hasComposerState, savedComposerDraft, savedRunOptions } from "./composerDraftStore.ts";

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
  assert.deepEqual(savedRunOptions({ permissionMode: "allow-all", budgetMode: "expert" }), { permissionMode: "allow-all", budgetMode: "expert" });
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
