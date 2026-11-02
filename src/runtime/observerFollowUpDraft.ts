import type { EffectInput, Finding, FollowUp, FollowUpReferenceInput, ImplementationInput } from "../pi/observer/types.ts";
import type { ObserverCopyKey } from "../i18n/copy/observer.ts";
export type FollowUpSection = "implementation" | "effect";
export type EffectDraft = Omit<EffectInput, "sampleSize"> & { successCriteria: string; sampleSize: string; costNotes: string };
export type FollowUpDraft = { implementation: ImplementationInput; effect: EffectDraft };
export type FollowUpEditorState = {
  draft: FollowUpDraft; dirty: Record<FollowUpSection, boolean>; findingRevision: number; followUpRevision: number;
  saved?: FollowUp; latestFindingRevision: number; conflict: boolean; sourceCleared: boolean;
};
type Snapshot = Pick<Finding, "revision" | "followUp">;
export const sourceRunKey = (ref: FollowUpReferenceInput) => JSON.stringify([ref.source.instanceId, ref.source.conversationId, ref.source.generation, ref.runId]);
export const sourceReferenceKey = (ref: FollowUpReferenceInput) => JSON.stringify([sourceRunKey(ref), ref.version]);
export const followUpReferenceInput = (ref: FollowUpReferenceInput): FollowUpReferenceInput => ({ kind: "conversation_run", source: { instanceId: ref.source.instanceId, conversationId: ref.source.conversationId, generation: ref.source.generation }, version: ref.version, runId: ref.runId });
export function followUpDraft(record?: FollowUp): FollowUpDraft {
  return {
    implementation: record?.implementation ? { status: record.implementation.status, summary: record.implementation.summary, references: record.implementation.references.map(followUpReferenceInput) } : { status: "planned", summary: "", references: [] },
    effect: record?.effect ? { judgment: record.effect.judgment, summary: record.effect.summary, baseline: record.effect.baseline.map(followUpReferenceInput), candidate: record.effect.candidate.map(followUpReferenceInput), successCriteria: record.effect.successCriteria ?? "", sampleSize: record.effect.sampleSize === undefined ? "" : String(record.effect.sampleSize), costNotes: record.effect.costNotes ?? "" } : { judgment: "not_evaluated", summary: "", baseline: [], candidate: [], successCriteria: "", sampleSize: "", costNotes: "" },
  };
}
export function initialFollowUpEditor(finding: Snapshot): FollowUpEditorState {
  return { draft: followUpDraft(finding.followUp), dirty: { implementation: false, effect: false }, findingRevision: finding.revision, followUpRevision: finding.followUp?.revision ?? 0,
    saved: finding.followUp, latestFindingRevision: finding.revision, conflict: false, sourceCleared: Boolean(finding.followUp?.clearedSections?.length) };
}
/** Polls preserve edits; explicit rebase acknowledges the new versions without replaying a write. */
export function receiveFollowUp(state: FollowUpEditorState, finding: Snapshot, mode: "poll" | "rebase" | "discard" | FollowUpSection = "poll"): FollowUpEditorState {
  const revision = finding.followUp?.revision ?? 0;
  if (revision < (state.saved?.revision ?? 0) || finding.revision < state.latestFindingRevision) return state;
  const changed = revision !== state.followUpRevision || finding.revision !== state.findingRevision;
  if (!changed && mode === "poll") return state;
  const dirty = { ...state.dirty }, incoming = followUpDraft(finding.followUp), draft = { ...state.draft };
  const cleared = revision > (state.saved?.revision ?? 0) ? (finding.followUp?.clearedSections ?? []).filter(section =>
    !state.saved?.clearedSections?.includes(section) || Boolean(state.saved?.[section] && !finding.followUp?.[section])) : [];
  for (const section of ["implementation", "effect"] as const) {
    if (mode === "discard" || mode === section || cleared.includes(section)) dirty[section] = false;
    if (!dirty[section]) {
      if (section === "implementation") draft.implementation = incoming.implementation;
      else draft.effect = incoming.effect;
    }
  }
  const conflict = mode === "poll" && changed && (dirty.implementation || dirty.effect);
  return { draft, dirty, findingRevision: conflict ? state.findingRevision : finding.revision, followUpRevision: conflict ? state.followUpRevision : revision,
    saved: finding.followUp, latestFindingRevision: finding.revision, conflict, sourceCleared: state.sourceCleared || cleared.length > 0 };
}
export function followUpDraftError(section: FollowUpSection, draft: FollowUpDraft): ObserverCopyKey | undefined {
  const record = draft[section];
  if (!record.summary.trim()) return "recordSummaryRequired";
  if (section === "implementation") return draft.implementation.status === "implemented" && !draft.implementation.references.length ? "implementationReferenceNeeded" : undefined;
  const effect = draft.effect;
  if (effect.sampleSize && (!Number.isSafeInteger(Number(effect.sampleSize)) || Number(effect.sampleSize) < 1 || Number(effect.sampleSize) > 1_000_000)) return "invalidSamples";
  if (["improved", "unchanged", "regressed"].includes(effect.judgment) && (!effect.baseline.length || !effect.candidate.length || !effect.successCriteria.trim())) return "comparisonRequired";
  if (effect.baseline.some(ref => effect.candidate.some(other => sourceRunKey(ref) === sourceRunKey(other)))) return "comparisonRequired";
  return undefined;
}
export function effectInputFromDraft(draft: EffectDraft): EffectInput {
  return { judgment: draft.judgment, summary: draft.summary, baseline: draft.baseline, candidate: draft.candidate,
    ...(draft.successCriteria.trim() ? { successCriteria: draft.successCriteria.trim() } : {}), ...(draft.sampleSize ? { sampleSize: Number(draft.sampleSize) } : {}), ...(draft.costNotes.trim() ? { costNotes: draft.costNotes.trim() } : {}) };
}
export function followUpReferenceStatus(ref: FollowUpReferenceInput, sources: import("../pi/observer/types.ts").FollowUpSource[], complete: boolean): ObserverCopyKey {
  const source = sources.find(item => sourceRunKey({ ...item, kind: "conversation_run" }) === sourceRunKey(ref));
  return source ? source.version === ref.version ? "sourceSnapshotMatches" : "sourceSnapshotChanged" : complete ? "sourceUnavailable" : "sourceNotLoaded";
}
