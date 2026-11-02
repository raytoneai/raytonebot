import type { ControlAuthorization } from "../controlPlaneAuth.ts";
import { safeText, sourceKey } from "./evidence.ts";
import { ObserverError, type EffectInput, type FollowUp, type FollowUpReference, type FollowUpReferenceInput, type FollowUpSource, type ImplementationInput } from "./types.ts";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number, required = true): string | undefined => {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || required && !value.trim()) throw new ObserverError("observer_follow_up_invalid");
  return safeText(value.trim(), max);
};
export const followUpReferenceKey = (value: FollowUpReferenceInput) => `${sourceKey(value.source)}:${value.runId}`;
function references(value: unknown): FollowUpReferenceInput[] {
  if (!Array.isArray(value) || value.length > 8) throw new ObserverError("observer_follow_up_invalid");
  const result = value.map(item => {
    if (!record(item) || !keys(item, ["kind", "source", "version", "runId"]) || item.kind !== "conversation_run" || !record(item.source) || !keys(item.source, ["instanceId", "conversationId", "generation"])
      || ![item.source.instanceId, item.source.conversationId, item.source.generation, item.runId].every(id => typeof id === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(id))
      || typeof item.version !== "string" || !/^[a-f0-9]{64}$/.test(item.version)) throw new ObserverError("observer_follow_up_source_invalid", 409);
    return structuredClone(item) as FollowUpReferenceInput;
  });
  if (new Set(result.map(followUpReferenceKey)).size !== result.length) throw new ObserverError("observer_follow_up_invalid");
  return result;
}
/** All human fields are parsed before host-only provenance or source metadata is attached. */
export function implementationInput(value: unknown): ImplementationInput {
  if (!record(value) || !keys(value, ["status", "summary", "references"]) || !["planned", "in_progress", "implemented", "abandoned"].includes(value.status as string)) throw new ObserverError("observer_follow_up_invalid");
  const refs = references(value.references);
  if (value.status === "implemented" && !refs.length) throw new ObserverError("observer_follow_up_source_required");
  return { status: value.status as ImplementationInput["status"], summary: text(value.summary, 2000)!, references: refs };
}
export function effectInput(value: unknown): EffectInput {
  if (!record(value) || !keys(value, ["judgment", "summary", "baseline", "candidate", "successCriteria", "sampleSize", "costNotes"]) || !["not_evaluated", "inconclusive", "improved", "unchanged", "regressed"].includes(value.judgment as string)) throw new ObserverError("observer_follow_up_invalid");
  const baseline = references(value.baseline), candidate = references(value.candidate), criteria = text(value.successCriteria, 1000, false);
  if (["improved", "unchanged", "regressed"].includes(String(value.judgment)) && (!baseline.length || !candidate.length || !criteria)) throw new ObserverError("observer_follow_up_comparison_required");
  if (baseline.some(ref => candidate.some(other => followUpReferenceKey(ref) === followUpReferenceKey(other)))) throw new ObserverError("observer_follow_up_comparison_invalid");
  if (value.sampleSize !== undefined && (!Number.isSafeInteger(value.sampleSize) || Number(value.sampleSize) < 1 || Number(value.sampleSize) > 1000000)) throw new ObserverError("observer_follow_up_invalid");
  const costNotes = text(value.costNotes, 1000, false);
  return { judgment: value.judgment as EffectInput["judgment"], summary: text(value.summary, 2000)!, baseline, candidate, ...(criteria ? { successCriteria: criteria } : {}), ...(value.sampleSize !== undefined ? { sampleSize: Number(value.sampleSize) } : {}), ...(costNotes ? { costNotes } : {}) };
}
export function resolveFollowUpReferences(refs: FollowUpReferenceInput[], sources: FollowUpSource[]): FollowUpReference[] {
  return refs.map(ref => {
    const source = sources.find(item => sourceKey(item.source) === sourceKey(ref.source) && item.runId === ref.runId);
    if (!source || source.version !== ref.version) throw new ObserverError("observer_follow_up_source_changed", 409);
    return { ...structuredClone(ref), harness: source.harness, ...(source.model ? { model: structuredClone(source.model) } : {}), contextFreshness: "unknown" };
  });
}
export function followUpProvenance(findingRevision: number, authorization: ControlAuthorization, now: number) {
  if (authorization.requestedBy !== "user_session" || authorization.scope !== "developer" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(authorization.authorizedVia)) throw new ObserverError("observer_authorization_revoked", 403);
  return { findingRevision, recordedAt: now, requestedBy: "user_session" as const, authorizedVia: authorization.authorizedVia, verification: "user_recorded" as const };
}
export function clearFollowUpSources(followUp: FollowUp | undefined, valid: (source: FollowUpReference["source"]) => boolean, now: number): FollowUp | undefined {
  if (!followUp) return;
  const implementation = followUp.implementation && followUp.implementation.references.some(ref => !valid(ref.source));
  const effect = followUp.effect && [...followUp.effect.baseline, ...followUp.effect.candidate].some(ref => !valid(ref.source));
  if (!implementation && !effect) return followUp;
  return { ...followUp, revision: followUp.revision + 1, ...(implementation ? { implementation: undefined } : {}), ...(effect ? { effect: undefined } : {}), clearedSections: [...new Set([...(followUp.clearedSections ?? []), ...(implementation ? ["implementation" as const] : []), ...(effect ? ["effect" as const] : [])])], clearedAt: now };
}
/** Old findings have no followUp. Present records must validate completely before becoming readable. */
export function validFollowUp(value: unknown): value is FollowUp {
  try {
    if (!record(value) || !keys(value, ["revision", "implementation", "effect", "clearedSections", "clearedAt"]) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return false;
    if (value.clearedSections !== undefined && (!Array.isArray(value.clearedSections) || value.clearedSections.length > 2 || value.clearedSections.some(section => !["implementation", "effect"].includes(String(section))))) return false;
    if (value.clearedAt !== undefined && (!Number.isSafeInteger(value.clearedAt) || Number(value.clearedAt) < 0)) return false;
    for (const section of ["implementation", "effect"] as const) if (value[section] !== undefined) {
      const saved = value[section]; if (!record(saved)) return false;
      const metadata = ["findingRevision", "recordedAt", "requestedBy", "authorizedVia", "verification"];
      if (!Number.isSafeInteger(saved.findingRevision) || Number(saved.findingRevision) < 1 || !Number.isSafeInteger(saved.recordedAt) || Number(saved.recordedAt) < 0 || saved.requestedBy !== "user_session" || saved.verification !== "user_recorded" || typeof saved.authorizedVia !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(saved.authorizedVia)) return false;
      const plain = Object.fromEntries(Object.entries(saved).filter(([key]) => !metadata.includes(key)));
      const referenceKeys = section === "implementation" ? ["references"] : ["baseline", "candidate"];
      for (const key of referenceKeys) {
        if (!Array.isArray(plain[key])) return false;
        plain[key] = plain[key].map((ref: unknown) => {
          if (!record(ref) || !keys(ref, ["kind", "source", "version", "runId", "harness", "model", "contextFreshness"]) || typeof ref.harness !== "string" || !["pi", "claude-code", "codex", "dsh", "unknown"].includes(ref.harness) || ref.contextFreshness !== "unknown") throw new Error();
          if (ref.model !== undefined && (!record(ref.model) || !keys(ref.model, ["provider", "model"]) || !text(ref.model.provider, 256) || !text(ref.model.model, 256))) throw new Error();
          return { kind: ref.kind, source: ref.source, version: ref.version, runId: ref.runId };
        });
      }
      if (section === "implementation") implementationInput(plain); else effectInput(plain);
    }
    return true;
  } catch { return false; }
}

export function followUpSourcesFromProjections(conversations: import("./types.ts").ConversationProjection[]): FollowUpSource[] {
  return conversations.filter(item => !item.source.conversationId.startsWith("observer:") && !item.source.conversationId.includes(".m.")).flatMap(conversation => {
    const runIds = new Set(conversation.events.flatMap(event => event.runId ? [event.runId] : []));
    return [...runIds].map(runId => {
      const events = conversation.events.filter(event => event.runId === runId), at = events.find(event => Number.isFinite(event.at))?.at, terminal = [...events].reverse().find(event => event.type === "terminal");
      return { source: conversation.source, version: conversation.version, conversationTitle: conversation.source.conversationId, botId: conversation.botId, harness: conversation.harness as FollowUpSource["harness"], contextFreshness: "unknown" as const, runId, ...(at !== undefined ? { at } : {}), ...(terminal?.status ? { status: terminal.status } : {}) };
    });
  });
}