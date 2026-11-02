import assert from "node:assert/strict";
import { test } from "node:test";
import type { FollowUp, FollowUpReference, FollowUpReferenceInput } from "../pi/observer/types.ts";
import { effectInputFromDraft, followUpDraftError, followUpReferenceStatus, initialFollowUpEditor, receiveFollowUp, type FollowUpEditorState } from "./observerFollowUpDraft.ts";
import { observerFollowUpMarkdown, observerEvidenceOutput, observerOutputMatchesFinding } from "./observerPresentation.ts";
const ref = (runId: string): FollowUpReferenceInput => ({ kind: "conversation_run", source: { instanceId: "instance", conversationId: "source-chat", generation: "generation" }, version: "a".repeat(64), runId });
const storedRef = (runId: string): FollowUpReference => ({ ...ref(runId), harness: "pi", model: { provider: "actual-provider", model: "actual-model" }, contextFreshness: "unknown" });
const provenance = { findingRevision: 1, recordedAt: 1000, requestedBy: "user_session" as const, authorizedVia: "private-audit-id", verification: "user_recorded" as const };
const record = (revision: number): FollowUp => ({ revision, implementation: { status: "implemented", summary: "Saved implementation", references: [storedRef("implemented-run")], ...provenance }, effect: { judgment: "inconclusive", summary: "Need more samples", baseline: [], candidate: [], ...provenance } });
function edited(): FollowUpEditorState {
  const state = initialFollowUpEditor({ revision: 1, followUp: record(1) });
  return { ...state, draft: { ...state.draft, implementation: { ...state.draft.implementation, summary: "Local draft" } }, dirty: { implementation: true, effect: false } };
}
test("legacy findings start with empty records and stored provenance never enters writable drafts", () => {
  const empty = initialFollowUpEditor({ revision: 5 });
  assert.equal(empty.followUpRevision, 0); assert.equal(empty.draft.effect.judgment, "not_evaluated");
  assert.equal(empty.draft.effect.sampleSize, "");
  const loaded = initialFollowUpEditor({ revision: 1, followUp: record(2) });
  assert.deepEqual(Object.keys(loaded.draft.implementation.references[0]).sort(), ["kind", "runId", "source", "version"]);
  assert.equal(JSON.stringify(loaded.draft).includes("private-audit-id"), false);
});
test("polling and independent revision conflicts keep edits until an explicit rebase, without replaying a write", () => {
  const original = edited();
  const conflicted = receiveFollowUp(original, { revision: 2, followUp: record(3) });
  assert.equal(conflicted.conflict, true); assert.equal(conflicted.draft.implementation.summary, "Local draft");
  assert.equal(conflicted.findingRevision, 1); assert.equal(conflicted.followUpRevision, 1);
  const rebased = receiveFollowUp(conflicted, { revision: 2, followUp: record(3) }, "rebase");
  assert.equal(rebased.conflict, false); assert.equal(rebased.draft.implementation.summary, "Local draft");
  assert.equal(rebased.findingRevision, 2); assert.equal(rebased.followUpRevision, 3);
  assert.equal(receiveFollowUp(rebased, { revision: 1, followUp: record(2) }), rebased, "late older reads cannot undo the acknowledged base");
  const discarded = receiveFollowUp(conflicted, { revision: 2, followUp: record(3) }, "discard");
  assert.equal(discarded.draft.implementation.summary, "Saved implementation"); assert.equal(discarded.dirty.implementation, false);
});
test("saving one section advances the shared record revision while preserving edits to the other section", () => {
  const dirty = edited(); dirty.draft.effect.summary = "Unsaved outcome"; dirty.dirty.effect = true;
  const saved = receiveFollowUp(dirty, { revision: 1, followUp: record(2) }, "implementation");
  assert.equal(saved.followUpRevision, 2); assert.equal(saved.dirty.implementation, false);
  assert.equal(saved.draft.effect.summary, "Unsaved outcome"); assert.equal(saved.dirty.effect, true);
});
test("source deletion clears affected text and references, while unrelated drafts remain available for explicit rebase", () => {
  const dirty = edited(); dirty.draft.effect.summary = "Unrelated local outcome"; dirty.dirty.effect = true;
  const cleared = receiveFollowUp(dirty, { revision: 1, followUp: { ...record(2), implementation: undefined, clearedSections: ["implementation"], clearedAt: 2000 } });
  assert.equal(cleared.draft.implementation.summary, ""); assert.deepEqual(cleared.draft.implementation.references, []);
  assert.equal(cleared.dirty.implementation, false); assert.equal(cleared.sourceCleared, true);
  assert.equal(cleared.draft.effect.summary, "Unrelated local outcome"); assert.equal(cleared.conflict, true);
});
test("definite outcomes require criteria and distinct source runs, while insufficient evidence stays explicitly unknown", () => {
  const state = initialFollowUpEditor({ revision: 1 });
  state.draft.implementation = { status: "implemented", summary: "Done", references: [] };
  assert.equal(followUpDraftError("implementation", state.draft), "implementationReferenceNeeded");
  state.draft.effect = { judgment: "improved", summary: "User thinks it improved", baseline: [], candidate: [], sampleSize: "", successCriteria: "", costNotes: "" };
  assert.equal(followUpDraftError("effect", state.draft), "comparisonRequired");
  state.draft.effect.baseline = [ref("same-run")]; state.draft.effect.candidate = [{ ...ref("same-run"), version: "b".repeat(64) }]; state.draft.effect.successCriteria = "Fewer failures";
  assert.equal(followUpDraftError("effect", state.draft), "comparisonRequired");
  state.draft.effect.candidate = [ref("different-run")];
  assert.equal(followUpDraftError("effect", state.draft), undefined);
  state.draft.effect.sampleSize = "0"; assert.equal(followUpDraftError("effect", state.draft), "invalidSamples");
  state.draft.effect = { judgment: "inconclusive", summary: "No controlled comparison", baseline: [], candidate: [], sampleSize: "", successCriteria: "", costNotes: "" };
  assert.equal(followUpDraftError("effect", state.draft), undefined);
  assert.equal(effectInputFromDraft(state.draft.effect).sampleSize, undefined);
});
test("reports show complete saved user records and disclose unverified comparisons in all three locales", () => {
  for (const locale of ["en", "zh", "ja"] as const) {
    const text = observerFollowUpMarkdown({ followUp: record(4) }, locale);
    assert.match(text, /Saved implementation/); assert.match(text, /Need more samples/);
    assert.match(text, /source-chat/); assert.match(text, /implemented-run/); assert.match(text, /actual-provider/);
    assert.equal(text.includes("private-audit-id"), false);
    assert.ok(text.includes(locale === "en" ? "not been confirmed" : locale === "zh" ? "尚未确认" : "未確認"));
  }
});

test("independent follow-up changes invalidate reports and deleted outcome text while evidence retains its own version", () => {
  const finding = { id: "finding", revision: 4, validity: "stale" as const, followUp: record(2) };
  const report = { observerRef: { id: finding.id, revision: finding.revision, validity: finding.validity, followUpRevision: 2 } };
  const cleared = { ...finding, followUp: { revision: 3, clearedSections: ["effect" as const], clearedAt: 3000 } };
  assert.equal(observerOutputMatchesFinding(report, finding), true);
  assert.equal(observerOutputMatchesFinding(report, cleared), false, "source cleanup must clear the already-open old effect report");
  const evidence = observerEvidenceOutput(finding, "evidence", { title: "Code", language: "text", text: "source", validity: "stale", sourceLabel: "source", readOnly: true }, "en");
  assert.equal(observerOutputMatchesFinding(evidence, cleared), true, "an independent follow-up edit does not change referenced evidence");
});

test("consecutive source deletions clear both private drafts even when timestamps match or move backward", () => {
  let state = edited();
  state.draft.effect.summary = "Private effect draft"; state.dirty.effect = true;
  state = receiveFollowUp(state, { revision: 1, followUp: { ...record(2), implementation: undefined, clearedSections: ["implementation"], clearedAt: 2000 } });
  assert.equal(state.draft.implementation.summary, "");
  state = receiveFollowUp(state, { revision: 1, followUp: { revision: 3, clearedSections: ["implementation", "effect"], clearedAt: 2000 } });
  assert.equal(state.draft.effect.summary, ""); assert.equal(state.dirty.effect, false);
  state = receiveFollowUp(state, { revision: 1, followUp: record(4) }, "rebase");
  state.draft.implementation.summary = "Restored private draft"; state.dirty.implementation = true;
  state = receiveFollowUp(state, { revision: 1, followUp: { ...record(5), implementation: undefined, clearedSections: ["implementation"], clearedAt: 1000 } });
  assert.equal(state.draft.implementation.summary, ""); assert.equal(state.dirty.implementation, false);
});

test("reference status distinguishes changed metadata from matching identity and incomplete source pages", () => {
  const reference = ref("run");
  const source = { ...reference, conversationTitle: "A task", botId: "assistant", harness: "pi" as const, contextFreshness: "unknown" as const };
  assert.equal(followUpReferenceStatus(reference, [source], true), "sourceSnapshotMatches");
  assert.equal(followUpReferenceStatus(reference, [{ ...source, version: "b".repeat(64) }], true), "sourceSnapshotChanged");
  assert.equal(followUpReferenceStatus(reference, [], false), "sourceNotLoaded");
  assert.equal(followUpReferenceStatus(reference, [], true), "sourceUnavailable");
});
