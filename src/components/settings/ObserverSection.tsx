import { ObserverFollowUp } from "./ObserverFollowUp";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n/LocaleContext";
import { observerRunLabel, observerText } from "../../i18n/copy/observer";
import type { Finding, ObserverBudget } from "../../pi/observer/types";
import type { BotProfile } from "../../runtime/botProfiles";
import { agentPreset } from "../../pi/harnessCatalog";
import type { ObserverSettingsState } from "../../runtime/useObserver";
import { getObserverEvidence, getObserverFinding, type ObserverHandoff } from "../../runtime/observerClient";
import { observerEvidenceOutput, observerFindingOutput } from "../../runtime/observerPresentation";
import type { OutputPanelItem } from "../agent-preview/outputframe/panelItem";
import { Button, Switch } from "../ui";
const budgetKeys = ["dailyRequests", "maxRequests", "maxDurationMs", "maxQueries", "maxBytes", "pageBytes", "pageSize"] as const;
type ObserverHandoffDraft = { botId: string; scope: string };

/** The existing SettingsDialog owns this developer section and its review controls. */
export function ObserverSection({ observer, bots, onOpenChat, onOpenOutput, onHandoff, onOpenConversation }: {
  observer: ObserverSettingsState; bots: readonly BotProfile[];
  onOpenChat: () => void; onOpenOutput: (item: OutputPanelItem) => void;
  onHandoff: (handoff: ObserverHandoff, draft: string) => void;
  onOpenConversation?: (id: string, target?: { runId?: string; textId?: string }) => void;
}) {
  const { locale } = useLocale();
  const t = (key: Parameters<typeof observerText>[1]) => observerText(locale, key);
  const { state, busy, error } = observer;
  const [enabled, setEnabled] = useState(false), [background, setBackground] = useState(false), [model, setModel] = useState("");
  const [windowDays, setWindowDays] = useState(7);
  const [budget, setBudget] = useState<ObserverBudget>();
  const [handoffDrafts, setHandoffDrafts] = useState<Record<string, ObserverHandoffDraft>>({});
  const [notice, setNotice] = useState<"sent" | "failed">();
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!state) return;
    setEnabled(state.enabled); setBackground(state.backgroundEnabled); setWindowDays(state.windowDays); setBudget(state.budgets);
    setModel(state.model ? JSON.stringify([state.model.provider, state.model.model]) : "");
  }, [state?.revision]);
  const open = async (finding: Finding, evidenceId?: string) => {
    if (opening) return;
    setOpening(true); setNotice(undefined);
    try {
      const item = evidenceId ? observerEvidenceOutput(finding, evidenceId, await getObserverEvidence(finding.id, finding.revision, evidenceId), locale)
        : observerFindingOutput(await getObserverFinding(finding.id, finding.revision), locale);
      if (mounted.current) onOpenOutput(item);
    } catch { if (mounted.current) { setNotice("failed"); void observer.refresh(); } }
    finally { if (mounted.current) setOpening(false); }
  };
  const selected = state?.models.find(item => JSON.stringify([item.provider, item.model]) === model);
  const runAllowed = Boolean(state?.enabled && state.model?.available);
  const defaultBotId = bots[0]?.id ?? "";
  const updateHandoffDraft = (findingId: string, update: Partial<ObserverHandoffDraft>) => setHandoffDrafts(current => {
    const draft = current[findingId] ?? { botId: defaultBotId, scope: "" };
    return { ...current, [findingId]: { ...draft, ...update } };
  });
  return <section className="settings-section settings-learning" data-observer-settings>
    <h3>{t("title")}</h3>
    <p className="settings-note">{t("explanation")}</p>
    <p className="settings-note">{t("view")}</p>
    {error || notice === "failed" ? <p role="alert">{t("failed")}</p> : null}
    {notice === "sent" ? <p role="status">{t("sent")}</p> : null}
    {!state || !budget ? <Button size="sm" onClick={() => void observer.refresh()}>{t("reload")}</Button> : <>
      <form onSubmit={event => { event.preventDefault(); void observer.update({ action: "settings", revision: state.revision, enabled, backgroundEnabled: background, windowDays,
        model: selected ? { provider: selected.provider, model: selected.model } : null, budgets: budget }); }}>
        <label className="settings-row"><span>{t("enabled")}</span><Switch size="sm" aria-label={t("enabled")} checked={enabled} disabled={busy} onCheckedChange={setEnabled} /></label>
        <label className="settings-row"><span>{t("background")}</span><Switch size="sm" aria-label={t("background")} checked={background} disabled={busy || !enabled} onCheckedChange={setBackground} /></label>
        <label className="settings-row"><span>{t("model")}</span><select aria-label={t("model")} value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
          <option value="">{t("select")}</option>
          {state.models.map(item => <option key={JSON.stringify([item.provider, item.model])} value={JSON.stringify([item.provider, item.model])} disabled={!item.available}>{item.label}</option>)}
        </select></label>
        <label className="settings-row"><span>{t("windowDays")}</span><input aria-label={t("windowDays")} type="number" min={1} max={366} step={1} value={windowDays} disabled={busy} onChange={event => setWindowDays(Number(event.target.value))} /></label>
        <details><summary>{t("budget")}</summary>{budgetKeys.map(key => <label className="settings-row" key={key}><span>{t(key)}</span><input aria-label={t(key)} type="number" min={1} step={1} value={budget[key]} disabled={busy} onChange={event => setBudget(current => current && ({ ...current, [key]: Number(event.target.value) }))} /></label>)}</details>
        <Button size="sm" type="submit" disabled={busy || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 366 || enabled && !selected?.available || !budgetKeys.every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)}>{t("save")}</Button>
      </form>
      {!state.model?.available ? <p className="settings-note">{t("unavailable")}</p> : null}
      <h4>{t("usage")} · {state.usage.day}</h4>
      <p>{t("calls")}: {state.usage.calls}/{state.budgets.dailyRequests} · {t("tokens")}: {state.usage.inputTokens}/{state.usage.outputTokens} · {t("unknown")}: {state.usage.unknownUsage}</p>
      <p className="settings-note">{t("usageNote")}</p>
      <p role="status">{observerRunLabel(locale, state.runState.status ?? (state.runState.running ? "running" : "idle"))}{state.runState.errorCode ? ` · ${state.runState.errorCode}` : ""}</p>
      {!state.l2Available ? <p className="settings-note">{t("platformUnavailable")}{state.l2UnavailableReason ? ` (${state.l2UnavailableReason})` : ""}</p> : null}
      <div className="settings-provider-actions">
        <Button size="sm" disabled={busy || !runAllowed || state.runState.running} onClick={() => void observer.update({ action: "analyze" })}>{t("analyze")}</Button>
        <Button size="sm" disabled={!runAllowed || !state.l2Available} onClick={onOpenChat}>{t("chat")}</Button>
        {state.runState.running && state.runState.runId ? <Button size="sm" disabled={busy} onClick={() => void observer.update({ action: "stop", runId: state.runState.runId! })}>{t("stop")}</Button> : null}
      </div>
      <p className="settings-note">{t("clearRunsNote")}</p>
      <Button size="sm" data-observer-clear-runs disabled={busy || !state.finishedWithoutFindings} onClick={() => void observer.update({ action: "clear_finished_runs" })}>{t("clearRuns")} ({state.finishedWithoutFindings ?? 0})</Button>
      <h4>{t("findings")}</h4>
      <p className="settings-note">{t("acceptedNote")}</p>
      {state.findings.length === 0 ? <p>{t("none")}</p> : null}
      {state.findings.map(finding => {
        const draft = handoffDrafts[finding.id] ?? { botId: defaultBotId, scope: "" };
        const targetBot = bots.find(bot => bot.id === draft.botId);
        return <article className="settings-provider-card" data-observer-finding={finding.id} key={finding.id}>
        <h4>{finding.title}</h4><p>{t(finding.reviewStatus)} · {t(finding.validity)} · #{finding.revision}</p>
        <p><strong>{t("action")}</strong>: {t(finding.proposedAction.kind)} · {finding.proposedAction.description}</p>
        <p>{t("target")}: {t(finding.proposedAction.target.kind)} / {finding.proposedAction.target.id}</p>
        <p>{t("scope")}: {finding.scope.map(source => `${source.conversationId} (${source.generation})`).join(", ") || finding.instanceId}</p>
        <p>{t("facts")}: {finding.factIds.join(", ")}</p>
        <p>{finding.inference}</p>
        <div className="settings-provider-actions">
          <Button size="sm" disabled={opening} onClick={() => void open(finding)}>{t("details")}</Button>
          {finding.evidenceRefs.map(ref => <Button size="sm" key={ref.id} disabled={opening} onClick={() => void open(finding, ref.id)}>{t("evidence")} · {ref.id}</Button>)}
          {(["accepted", "rejected", "disabled"] as const).map(status => <Button size="sm" key={status} disabled={busy || finding.reviewStatus === status || status === "accepted" && finding.validity !== "current"} onClick={() => void observer.update({ action: "review", id: finding.id, revision: finding.revision, status })}>{t(({ accepted: "accept", rejected: "reject", disabled: "disable" } as const)[status])}</Button>)}
          <Button size="sm" disabled={busy} onClick={() => void observer.update({ action: "remove", id: finding.id, revision: finding.revision })}>{t("remove")}</Button>
        </div>
        <ObserverFollowUp finding={finding} onOpenConversation={onOpenConversation} refresh={observer.refresh} />
        <details><summary>{t("handoff")}</summary>
          <label className="settings-row"><span>{t("bot")}</span><select aria-label={`${t("bot")} · ${finding.title}`} value={draft.botId} onChange={event => updateHandoffDraft(finding.id, { botId: event.target.value })}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
          <label className="settings-row"><span>{t("handoffScope")}</span><textarea aria-label={`${t("handoffScope")} · ${finding.title}`} value={draft.scope} onChange={event => updateHandoffDraft(finding.id, { scope: event.target.value })} maxLength={1000} /></label>
          <Button size="sm" disabled={busy || finding.validity !== "current" || finding.reviewStatus !== "accepted" || !draft.scope.trim() || !targetBot} onClick={() => void observer.update({ action: "handoff", id: finding.id, revision: finding.revision, botId: draft.botId, scope: draft.scope.trim() }).then(result => {
            if (mounted.current && result?.handoff && result.draft) onHandoff(result.handoff, result.draft);
          })}>{t("handoff")}</Button>
          {finding.kind === "experience_candidate" ? <Button size="sm" disabled={busy || finding.validity !== "current" || finding.reviewStatus !== "accepted" || !targetBot} onClick={() => void observer.update({ action: "lesson", id: finding.id, revision: finding.revision, botId: draft.botId, harness: agentPreset(targetBot!.presetId).harness }).then(result => { if (mounted.current && result) setNotice("sent"); })}>{t("lesson")}</Button> : null}
        </details>
        </article>;
      })}
    </>}
  </section>;
}
