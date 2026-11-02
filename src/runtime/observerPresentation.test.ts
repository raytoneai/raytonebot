import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBotProfile } from "./botProfiles.ts";
import { isObserverConversation, OBSERVER_BOT_ID } from "./observerClient.ts";
import { conversationModelUnavailable, observerEvidenceOutput, observerFindingOutput } from "./observerPresentation.ts";
import { savedComposerDraft, writeComposerDraft, type SavedComposerDraft } from "./composerDraftStore.ts";
import type { Finding } from "../pi/observer/types.ts";
const finding: Finding = {
  schemaVersion: 1, id: "finding-a", revision: 2, observerRunId: "run-a", analysisLevel: "L2", kind: "project_suggestion",
  requestedBy: "user_session", authorizedVia: "session-id", instanceId: "instance-a", createdAt: 1,
  model: { provider: "configured-provider", model: "configured-model", configRevision: "1" }, instructionVersion: "1",
  buildStamp: { schemaVersion: 1, gitRevision: null, dirty: true, manifestHash: "manifest", buildId: "local" }, readScopeHash: "scope",
  querySet: [], facts: [{ id: "fact-a", runId: "run-a", kind: "observed_error", value: { code: "E_TEST" }, evidenceIds: ["ref-a"] }],
  evidenceRefs: [{ id: "ref-a", runId: "run-a", kind: "repo", hash: "hash", version: "1", locator: { path: "src/file.ts", startLine: 1, endLine: 2 }, queryId: "q-a" }],
  factIds: ["fact-a"], inference: "Possible cause; verify the evidence.", title: "Investigate the error",
  proposedAction: { kind: "add_test", target: { kind: "code", id: "src/file.ts" }, description: "Add a regression check", verificationRefs: ["ref-a"] },
  scope: [{ instanceId: "instance-a", conversationId: "source-chat", generation: "g1" }], reviewStatus: "accepted", validity: "stale",
  budgetSpent: { requests: 1, queries: 1, bytes: 20, inputTokens: 0, outputTokens: 0, unknownUsage: 1, durationMs: 1 }, dedupKey: "dedup",
};
test("system identity is separate from editable profiles and cannot be created by a name or prefix", () => {
  assert.equal(isObserverConversation({ id: "chat-a", botId: "assistant" }), false);
  assert.equal(isObserverConversation({ id: "observer:fake", botId: "assistant" }), false);
  assert.equal(isObserverConversation({ id: "observer:real", botId: OBSERVER_BOT_ID, systemRole: "observer" }), true);
  assert.equal(parseBotProfile({ id: OBSERVER_BOT_ID, presetId: "assistant", name: "Observer", appearance: {} }), undefined);
});
test("Observer questions and queues cannot enter the normal persistent draft store", async () => {
  assert.throws(() => savedComposerDraft({ id: "observer:local", botId: OBSERVER_BOT_ID, title: "Private question", createdAt: 1, events: [] }, { prompt: "unsanitized question", attachments: [] }), /remain in memory/);
  await assert.rejects(writeComposerDraft({} as IDBDatabase, { id: "observer:local" } as SavedComposerDraft), /remain in memory/);
});
test("report previews show fact, inference, scope, validity and action separately in all locales", () => {
  for (const locale of ["en", "zh", "ja"] as const) {
    const item = observerFindingOutput(finding, locale);
    assert.equal(item.ephemeral, true);
    assert.match(item.body!, /fact-a/);
    assert.match(item.body!, /Possible cause/);
    assert.match(item.body!, /Add a regression check/);
    assert.match(item.body!, /source-chat/);
    assert.equal(item.downloadUrl, undefined);
    assert.equal(item.workspacePath, undefined);
    assert.equal(item.artifactId, undefined);
    assert.equal(item.observerRef?.revision, 2);
    assert.match(item.id, /:2:follow-up:0$/);
  }
});
test("untrusted HTML evidence opens as temporary source, without downloads, forms or workspace identity", () => {
  const item = observerEvidenceOutput(finding, "ref-a", { title: "source.html", language: "html", text: '<script>fetch("https://invalid.test")</script>', sourceLabel: "src/source.html:1", validity: "current", readOnly: true }, "en");
  assert.equal(item.ephemeral, true);
  assert.equal(item.kind, "review", "the existing review renderer displays source rather than executing HTML");
  assert.equal(item.downloadUrl, undefined);
  assert.equal(item.workspacePath, undefined);
  assert.equal(item.artifactId, undefined);
});

test("Observer reconnect replaces transient tool history before deriving the live cursor", async () => {
  const { observerHistoryBaseline } = await import("./observerClient.ts");
  const old = { id: "observer:test", botId: OBSERVER_BOT_ID, systemRole: "observer" as const, title: "Old", createdAt: 1, events: Array.from({ length: 80 }, (_, i) => ({ id: `transient-${i}`, type: "tool.call.finished", seq: i + 1, ts: 1, runId: "old-run", payload: {} })) };
  const events = [{ id: "projected-user", type: "text.started", seq: 1, ts: 1, runId: "old-run", payload: { role: "user", textId: "question" } }, { id: "active-start", type: "run.started", seq: 2, ts: 2, runId: "active-run", payload: {} }];
  const saved = { id: old.id, title: "Host projection", botId: OBSERVER_BOT_ID, systemRole: "observer" as const, createdAt: 1, updatedAt: 2, eventCount: events.length, agentPreset: "assistant" as const, events, activeRunId: "active-run" };
  const next = observerHistoryBaseline(old, saved);
  assert.equal(next.events, events);
  assert.equal(next.events.length, 2, "the live offset comes from the fresh projection, never 80 prior tool events");
  assert.equal(next.activeRunId, "active-run");
  assert.equal(next.events.some(event => event.id.startsWith("transient-")), false);
  assert.throws(() => observerHistoryBaseline(old, { ...saved, id: "observer:other" }), /invalid/);
  assert.throws(() => observerHistoryBaseline(old, { ...saved, botId: "assistant", systemRole: undefined }), /invalid/);
});

test("Observer host readiness does not fall through to the ordinary provider catalog", () => {
  for (const locale of ["en", "zh", "ja"] as const) {
    assert.equal(conversationModelUnavailable({ observer: true, observerAvailable: true, providerUnavailable: true }, locale, "Ordinary provider unavailable"), undefined);
    assert.ok(conversationModelUnavailable({ observer: true, observerAvailable: false, providerUnavailable: false }, locale, "Ordinary provider unavailable"));
    assert.equal(conversationModelUnavailable({ observer: false, observerAvailable: true, providerUnavailable: true }, locale, "Ordinary provider unavailable"), "Ordinary provider unavailable");
    assert.equal(conversationModelUnavailable({ observer: false, observerAvailable: false, providerUnavailable: false }, locale, "Ordinary provider unavailable"), undefined);
  }
});
