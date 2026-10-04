import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { appendPiConversationEvents, createEphemeralPiConversation } from "../pi/piConversationState.ts";
import { branchStoredConversation, checkPiAttachment, PiRequestError } from "../pi/piClient.ts";
import { savedComposerDraft, acceptedComposerDraft } from "./composerDraftStore.ts";
import { branchReplayEvents, branchMessageRuns, branchComposerDraft } from "./useMessageBranch.ts";

test("branch actions keep repeated assistant IDs tied to their own turns and preserve attachment references", () => {
  let conversation = createEphemeralPiConversation("source");
  for (const runId of ["first", "second"]) {
    const adapter = createPiEventAdapter({ runId });
    adapter.startUserMessage("Identical prompt");
    adapter.apply({ type: "message_start", message: { role: "assistant" } });
    adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Identical answer" } });
    adapter.finish("success");
    conversation = appendPiConversationEvents(conversation, adapter.events);
  }
  const snapshot = JSON.stringify(conversation.events);
  const view = createAgentUXViewModel(branchReplayEvents(conversation.events));
  const targets = branchMessageRuns(conversation.events);
  const messages = view.timeline.filter(item => item.kind === "message");
  assert.equal(new Set(messages.map(item => item.id)).size, 4);
  assert.deepEqual(messages.map(item => targets.get(item.id)), ["first", "first", "second", "second"]);
  assert.equal(JSON.stringify(conversation.events), snapshot, "display mapping must not rewrite saved events");
  const draft = branchComposerDraft({ prompt: "Original", attachments: [{ scope: "shared", path: "input.txt", name: "原文件.txt" }] });
  const saved = savedComposerDraft(conversation, draft);
  assert.deepEqual(saved.draft.attachments[0].reference, draft.attachments[0].reference);
  assert.equal(saved.draft.attachments[0].file, undefined);
  assert.equal(acceptedComposerDraft(draft, { requestId: "branch-run", prompt: "Original", attachmentIds: draft.attachments.map(file => file.id) }).attachments.length, 0);
});

test("branch client performs one bounded POST and surfaces refusal without submitting a prompt", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { beforeRunId: "second" });
    assert.ok(init?.signal);
    return Response.json({ error: "The source is still running" }, { status: 409 });
  };
  await assert.rejects(branchStoredConversation("source:id", "second", fetcher), error => error instanceof PiRequestError && error.status === 409);
  assert.deepEqual(calls, ["/__agentcanvas/pi/conversations/source%3Aid/branch"]);
  await assert.rejects(checkPiAttachment({ scope: "shared", path: "gone.txt" }, undefined, async (url, init) => {
    assert.match(String(url), /files\/download\?scope=shared&path=gone.txt/);
    assert.equal(init?.method, "HEAD"); assert.ok(init?.signal);
    return new Response(null, { status: 404 });
  }), /Restore or remove it/);
});
