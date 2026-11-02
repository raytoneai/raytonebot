import { observerFollowUpMarkdown } from "../../runtime/observerPresentation";
import { useEffect, useRef, useState } from "react";
import type { Finding, FollowUpReferenceInput, FollowUpSource, ImplementationInput, EffectInput } from "../../pi/observer/types";
import { getObserver, getObserverFollowUpSources, updateObserver } from "../../runtime/observerClient";
import { effectInputFromDraft, followUpDraftError, followUpReferenceInput, initialFollowUpEditor, receiveFollowUp, sourceReferenceKey, sourceRunKey, followUpReferenceStatus, type EffectDraft, type FollowUpSection } from "../../runtime/observerFollowUpDraft";
import { observerText, type ObserverCopyKey } from "../../i18n/copy/observer";
import { useLocale } from "../../i18n/LocaleContext";
import { Button } from "../ui";
const statuses: ImplementationInput["status"][] = ["planned", "in_progress", "implemented", "abandoned"];
const judgments: EffectInput["judgment"][] = ["not_evaluated", "inconclusive", "improved", "unchanged", "regressed"];
type OpenConversation = (id: string, target?: { runId?: string; textId?: string }) => void;

function ReferencePicker({ label, values, sources, complete, disabled, onChange, onOpen }: {
  label: string; values: FollowUpReferenceInput[]; sources: FollowUpSource[]; complete: boolean; disabled: boolean;
  onChange: (refs: FollowUpReferenceInput[]) => void; onOpen?: OpenConversation;
}) {
  const { locale } = useLocale();
  const sourceStatus = (status?: string) => observerText(locale, status === "success" ? "sourceRunCompleted" : status === "error" || status === "failed" ? "sourceRunFailed" : status === "running" ? "sourceRunRunning" : ["cancelled", "interrupted"].includes(status ?? "") ? status as "cancelled" | "interrupted" : "unknownValue");
  const options = new Map(sources.map(source => [sourceReferenceKey({ ...source, kind: "conversation_run" }), { ref: followUpReferenceInput({ ...source, kind: "conversation_run" }), label: `${source.conversationTitle} · ${source.at ? new Date(source.at).toLocaleString(locale) : observerText(locale, "unknownValue")} · ${sourceStatus(source.status)} · ${source.runId.slice(0, 8)}` }]));
  for (const ref of values) if (!options.has(sourceReferenceKey(ref))) options.set(sourceReferenceKey(ref), { ref, label: `${ref.source.conversationId} · ${ref.runId.slice(0, 8)}` });
  return <fieldset className="observer-follow-up-references">
    <legend>{label}</legend>
    {options.size ? <select aria-label={label} multiple size={Math.min(4, options.size)} value={values.map(sourceReferenceKey)} disabled={disabled} onChange={event => {
      const selected = Array.from(event.target.selectedOptions).map(option => options.get(option.value)!.ref);
      const unique = new Map<string, FollowUpReferenceInput>();
      for (const ref of selected) { const key = sourceRunKey(ref); if (!unique.has(key) || sources.some(source => sourceReferenceKey({ ...source, kind: "conversation_run" }) === sourceReferenceKey(ref))) unique.set(key, ref); }
      if (unique.size <= 8) onChange([...unique.values()]);
    }}>{[...options].map(([key, option]) => <option key={key} value={key}>{option.label}</option>)}</select> : <p className="settings-note">{observerText(locale, "noSources")}</p>}
    {values.length ? <ul>{values.map(ref => <li key={sourceReferenceKey(ref)}><span>{options.get(sourceReferenceKey(ref))?.label}</span><p className="settings-note">{observerText(locale, followUpReferenceStatus(ref, sources, complete))}</p>{onOpen ? <Button size="sm" disabled={disabled} onClick={() => onOpen(ref.source.conversationId, { runId: ref.runId })}>{observerText(locale, "openSource")}</Button> : null}</li>)}</ul> : null}
  </fieldset>;
}

/** Inline helper rendered only by the original SettingsDialog's Observer section. */
export function ObserverFollowUp({ finding, onOpenConversation, refresh }: { finding: Finding; onOpenConversation?: OpenConversation; refresh: () => unknown }) {
  const { locale } = useLocale();
  const t = (key: ObserverCopyKey) => observerText(locale, key);
  const [editor, setEditor] = useState(() => initialFollowUpEditor(finding));
  const [sources, setSources] = useState<FollowUpSource[]>([]), [cursor, setCursor] = useState<number>();
  const [query, setQuery] = useState("");
  const [sourceComplete, setSourceComplete] = useState(false);
  const loadedQuery = useRef("");
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState<FollowUpSection>();
  const [notice, setNotice] = useState<ObserverCopyKey>();
  const [showSaved, setShowSaved] = useState(false);
  const sourceListRevision = useRef(0);
  const sourceRequest = useRef<AbortController | undefined>(undefined), mounted = useRef(true), action = useRef(0);
  const sourcesLoaded = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; action.current++; sourceRequest.current?.abort(); }; }, []);
  useEffect(() => {
    setEditor(current => receiveFollowUp(current, finding));
    const revision = finding.followUp?.revision ?? 0;
    if (revision > sourceListRevision.current && finding.followUp?.clearedSections?.length) {
      sourceRequest.current?.abort(); setSources([]); setCursor(undefined); setSourceComplete(false); setLoading(false); sourcesLoaded.current = false;
    }
    sourceListRevision.current = revision;
  }, [finding.revision, finding.followUp]);
  const loadSources = async (next?: number) => {
    sourceRequest.current?.abort(); const request = new AbortController(); sourceRequest.current = request;
    const requestedQuery = query.trim();
    if (requestedQuery !== loadedQuery.current) next = undefined;
    setLoading(true); setNotice(undefined);
    try {
      const result = await getObserverFollowUpSources({ ...(next !== undefined ? { cursor: next } : {}), limit: 100, ...(query.trim() ? { query: query.trim() } : {}) }, request.signal);
      if (!mounted.current || request.signal.aborted) return;
      sourcesLoaded.current = true; loadedQuery.current = requestedQuery; setSourceComplete(!requestedQuery && result.nextCursor === undefined); setCursor(result.nextCursor);
      setSources(current => [...new Map([...(next === undefined ? [] : current), ...result.sources].map(source => [sourceReferenceKey({ ...source, kind: "conversation_run" }), source])).values()]);
    } catch { if (mounted.current && !request.signal.aborted) setNotice("failed"); }
    finally { if (mounted.current && !request.signal.aborted) setLoading(false); }
  };
  const reloadSaved = async () => {
    const ticket = ++action.current; setLoading(true); setNotice(undefined);
    try {
      const current = (await getObserver()).findings.find(item => item.id === finding.id);
      if (!mounted.current || ticket !== action.current) return;
      if (!current) { setEditor(initialFollowUpEditor({ revision: finding.revision })); setNotice("failed"); return; }
      setEditor(previous => receiveFollowUp(previous, current, "rebase")); setShowSaved(true); void refresh();
    } catch { if (mounted.current && ticket === action.current) setNotice("failed"); }
    finally { if (mounted.current && ticket === action.current) setLoading(false); }
  };
  const save = async (section: FollowUpSection) => {
    if (saving || loading || editor.conflict) return;
    const problem = followUpDraftError(section, editor.draft);
    if (problem) { setNotice(problem); return; }
    const ticket = ++action.current; setSaving(section); setNotice(undefined);
    try {
      const identity = { id: finding.id, revision: editor.findingRevision, followUpRevision: editor.followUpRevision };
      const result = await updateObserver(section === "implementation" ? { action: "record_implementation", ...identity, implementation: { ...editor.draft.implementation, references: editor.draft.implementation.references.map(followUpReferenceInput) } }
        : { action: "record_effect", ...identity, effect: effectInputFromDraft(editor.draft.effect) });
      if (!mounted.current || ticket !== action.current) return;
      if (!result.followUp) throw new Error("observer_follow_up_missing_receipt");
      setEditor(previous => receiveFollowUp(previous, { revision: identity.revision, followUp: result.followUp }, section));
      setNotice("followUpSaved"); void refresh();
    } catch (error) {
      if (!mounted.current || ticket !== action.current) return;
      const code = error instanceof Error ? error.message : "";
      if (["observer_follow_up_conflict", "observer_revision_conflict"].includes(code)) { setEditor(current => ({ ...current, conflict: true })); setNotice("followUpConflict"); }
      else if (code.startsWith("observer_follow_up_source") || code === "observer_follow_up_comparison_invalid") setNotice("comparisonRequired");
      else setNotice("failed");
      void refresh();
    } finally { if (mounted.current && ticket === action.current) setSaving(undefined); }
  };
  const implementation = editor.draft.implementation, effect = editor.draft.effect;
  const changeImplementation = (patch: Partial<ImplementationInput>) => { setNotice(undefined); setEditor(current => ({ ...current, draft: { ...current.draft, implementation: { ...current.draft.implementation, ...patch } }, dirty: { ...current.dirty, implementation: true } })); };
  const changeEffect = (patch: Partial<EffectDraft>) => { setNotice(undefined); setEditor(current => ({ ...current, draft: { ...current.draft, effect: { ...current.draft.effect, ...patch } }, dirty: { ...current.dirty, effect: true } })); };
  const disabled = Boolean(saving || loading);
  return <details data-observer-follow-up={finding.id} onToggle={event => { if (event.currentTarget.open && !sourcesLoaded.current) void loadSources(); }}>
    <summary>{t("followUp")}</summary>
    <p className="settings-note">{t("followUpNote")}</p><p className="settings-note">{t("comparisonUnverified")}</p><p className="settings-note">{t("sourceVersionNote")}</p>
    {finding.validity !== "current" ? <p className="settings-note">{t("staleFollowUp")}</p> : null}
    {!editor.saved?.implementation && !editor.saved?.effect ? <p>{t("noFollowUp")}</p> : null}
    <p>{t("recordRevision")}: {editor.saved?.revision ?? 0}</p>
    {editor.sourceCleared ? <p role="status">{t("sourceCleared")}</p> : null}
    {notice ? <p role={notice === "followUpSaved" ? "status" : "alert"}>{t(notice)}</p> : null}
    {editor.conflict ? <p role="alert">{t("followUpConflict")}</p> : null}
    {loading ? <p role="status">{t("refreshSources")}</p> : null}
    <div className="settings-row"><label htmlFor={`observer-source-query-${finding.id}`}>{t("sourceSearch")}</label><input id={`observer-source-query-${finding.id}`} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void loadSources(); } }} maxLength={200} /></div>
    <div className="settings-provider-actions"><Button size="sm" disabled={disabled} onClick={() => void loadSources()}>{t("refreshSources")}</Button>{cursor !== undefined ? <Button size="sm" disabled={disabled} onClick={() => void loadSources(cursor)}>{t("moreSources")}</Button> : null}</div>
    {editor.conflict ? <div className="settings-provider-actions"><Button size="sm" disabled={disabled} onClick={() => void reloadSaved()}>{t("loadLatest")}</Button><Button size="sm" disabled={disabled} onClick={() => setEditor(current => receiveFollowUp(current, { revision: current.latestFindingRevision, followUp: current.saved }, "discard"))}>{t("discardFollowUp")}</Button></div> : null}
    {editor.saved ? <details data-observer-saved-follow-up open={showSaved} onToggle={event => setShowSaved(event.currentTarget.open)}><summary>{t("latestSaved")}</summary><pre>{observerFollowUpMarkdown({ followUp: editor.saved }, locale)}</pre></details> : null}
    <form data-observer-implementation onSubmit={event => { event.preventDefault(); void save("implementation"); }}>
      <h5>{t("implementation")} · {t("userRecord")}</h5>
      {editor.saved?.implementation ? <p className="settings-note">{t("recordedAt")}: {new Date(editor.saved.implementation.recordedAt).toLocaleString(locale)}</p> : null}
      <label className="settings-row"><span>{t("implementationStatus")}</span><select aria-label={`${t("implementationStatus")} · ${finding.title}`} value={implementation.status} disabled={disabled} onChange={event => changeImplementation({ status: event.target.value as ImplementationInput["status"] })}>{statuses.map(status => <option key={status} value={status}>{t(status)}</option>)}</select></label>
      <label className="settings-row"><span>{t("implementationSummary")}</span><textarea aria-label={`${t("implementationSummary")} · ${finding.title}`} value={implementation.summary} disabled={disabled} maxLength={2000} onChange={event => changeImplementation({ summary: event.target.value })} /></label>
      <ReferencePicker label={`${t("linkedSources")} · ${finding.title}`} values={implementation.references} sources={sources} complete={sourceComplete} disabled={disabled} onChange={references => changeImplementation({ references })} onOpen={onOpenConversation} />
      {editor.dirty.implementation && followUpDraftError("implementation", editor.draft) ? <p className="settings-note">{t(followUpDraftError("implementation", editor.draft)!)}</p> : null}
      <Button size="sm" type="submit" disabled={disabled || editor.conflict || !editor.dirty.implementation || Boolean(followUpDraftError("implementation", editor.draft))}>{t("saveImplementation")}</Button>
    </form>
    <form data-observer-effect onSubmit={event => { event.preventDefault(); void save("effect"); }}>
      <h5>{t("effect")} · {t("userRecord")}</h5>
      {editor.saved?.effect ? <p className="settings-note">{t("recordedAt")}: {new Date(editor.saved.effect.recordedAt).toLocaleString(locale)}</p> : null}
      <label className="settings-row"><span>{t("effectJudgment")}</span><select aria-label={`${t("effectJudgment")} · ${finding.title}`} value={effect.judgment} disabled={disabled} onChange={event => changeEffect({ judgment: event.target.value as EffectInput["judgment"] })}>{judgments.map(judgment => <option key={judgment} value={judgment}>{t(judgment)}</option>)}</select></label>
      <label className="settings-row"><span>{t("successCriteria")}</span><textarea aria-label={`${t("successCriteria")} · ${finding.title}`} value={effect.successCriteria} disabled={disabled} maxLength={1000} onChange={event => changeEffect({ successCriteria: event.target.value })} /></label>
      <label className="settings-row"><span>{t("effectSummary")}</span><textarea aria-label={`${t("effectSummary")} · ${finding.title}`} value={effect.summary} disabled={disabled} maxLength={2000} onChange={event => changeEffect({ summary: event.target.value })} /></label>
      <ReferencePicker label={`${t("baseline")} · ${finding.title}`} values={effect.baseline} sources={sources} complete={sourceComplete} disabled={disabled} onChange={baseline => changeEffect({ baseline })} onOpen={onOpenConversation} />
      <ReferencePicker label={`${t("candidate")} · ${finding.title}`} values={effect.candidate} sources={sources} complete={sourceComplete} disabled={disabled} onChange={candidate => changeEffect({ candidate })} onOpen={onOpenConversation} />
      <label className="settings-row"><span>{t("samples")}</span><input aria-label={`${t("samples")} · ${finding.title}`} type="number" min={1} max={1000000} placeholder={t("unknownValue")} value={effect.sampleSize} disabled={disabled} onChange={event => changeEffect({ sampleSize: event.target.value })} /></label>
      <label className="settings-row"><span>{t("recordedCost")}</span><textarea aria-label={`${t("recordedCost")} · ${finding.title}`} value={effect.costNotes} placeholder={t("unknownValue")} disabled={disabled} maxLength={1000} onChange={event => changeEffect({ costNotes: event.target.value })} /></label>
      {editor.dirty.effect && followUpDraftError("effect", editor.draft) ? <p className="settings-note">{t(followUpDraftError("effect", editor.draft)!)}</p> : null}
      <Button size="sm" type="submit" disabled={disabled || editor.conflict || !editor.dirty.effect || Boolean(followUpDraftError("effect", editor.draft))}>{t("saveEffect")}</Button>
    </form>
  </details>;
}
