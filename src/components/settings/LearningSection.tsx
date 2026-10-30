import { featureCopy, featureText } from "../../i18n/copy/features.ts";
import { useLocale } from "../../i18n/LocaleContext";
import type { LearningSettings } from "../../runtime/useLearning";
import { Button, Switch } from "../ui";

export function LearningSection({ learning }: { learning: LearningSettings }) {
  const { locale } = useLocale();
  const { state, busy, error } = learning;
  const settings = (patch: Partial<Pick<NonNullable<typeof state>, "enabled" | "reuse" | "dailyLimit">>) => {
    if (state) void learning.update({ action: "settings", revision: state.revision, enabled: state.enabled, reuse: state.reuse, dailyLimit: state.dailyLimit, ...patch });
  };
  return <section className="settings-section">
    <h3>{featureText(locale, "Self-learning (RSL)")}</h3>
    <p className="settings-note">{featureText(locale, "Reviews complex tasks and corrections while idle. Text proposals only: engines, code, persona and user memory stay unchanged. Candidates require review. Disabled means no learning calls.")}</p>
    {error || state?.storageError ? <p role="alert">{error || state?.storageError}</p> : null}
    {!state ? <Button size="sm" onClick={() => void learning.refresh()}>{featureText(locale, "Reload")}</Button> : <>
      <label className="settings-row"><span>{featureText(locale, "Enable background learning")}</span><Switch size="sm" aria-label="RSL" checked={state.enabled} disabled={busy || Boolean(state.storageError)} onCheckedChange={enabled => settings({ enabled })} /></label>
      <label className="settings-row"><span>{featureText(locale, "Reuse approved lessons")}</span><Switch size="sm" aria-label={featureText(locale, "Reuse approved lessons")} checked={state.reuse} disabled={busy || !state.enabled || Boolean(state.storageError)} onCheckedChange={reuse => settings({ reuse })} /></label>
      <p className="settings-note">{featureText(locale, "Only relevant tasks for the same Bot and engine. Disabling cannot erase native session context; start a new conversation for a clean baseline.")}</p>
      <label className="settings-row"><span>{featureText(locale, "Daily call limit (UTC)")}</span><input aria-label={featureText(locale, "Daily call limit")} type="number" min={1} max={20} value={state.dailyLimit} disabled={busy || Boolean(state.storageError)} onChange={event => { const dailyLimit = Number(event.target.value); if (dailyLimit >= 1 && dailyLimit <= 20) settings({ dailyLimit }); }} /></label>
      <p className="settings-note">{featureText(locale, "Today")}: {state.calls}/{state.dailyLimit} · {featureText(locale, "Input tokens")} {state.inputTokens} · {featureText(locale, "Output tokens")} {state.outputTokens} · {featureText(locale, "Unknown usage")} {state.unknownUsage}</p>
      <p className="settings-note">{featureText(locale, "Queued")}: {state.queued} · {state.running ? (featureText(locale, "Reviewing")) : (featureText(locale, "Idle"))} · {state.lastResult && Object.hasOwn(featureCopy, state.lastResult) ? featureText(locale, state.lastResult as keyof typeof featureCopy) : state.lastResult}</p>
      <p className="settings-note">{featureText(locale, "Uses the task model: about 6000 input characters and 500 output tokens per call. Daily calls are capped; reported tokens may be incomplete and are not a bill. Queues do not survive restarts.")}</p>
      {state.candidates.length === 0 ? <p>{featureText(locale, "No candidates. Eligible new tasks are reviewed while idle once enabled.")}</p> : state.candidates.slice().reverse().map(candidate => <div key={candidate.id} className="settings-provider-card">
        <strong>{candidate.title}</strong><p>{candidate.trigger}</p><p style={{ whiteSpace: "pre-wrap" }}>{candidate.lesson}</p>
        <p className="settings-note">{candidate.botId} · {candidate.harness} · {featureText(locale, ({ pending: "Awaiting review", approved: "Approved", rejected: "Rejected" } as const)[candidate.status])} · {candidate.conversationId} / {candidate.runId}</p>
        <div className="settings-provider-actions"><Button size="sm" disabled={busy || candidate.status === "approved" || Boolean(state.storageError)} onClick={() => void learning.update({ action: "review", revision: state.revision, id: candidate.id, status: "approved" })}>{featureText(locale, "Approve")}</Button><Button size="sm" disabled={busy || candidate.status === "rejected" || Boolean(state.storageError)} onClick={() => void learning.update({ action: "review", revision: state.revision, id: candidate.id, status: "rejected" })}>{featureText(locale, "Reject / Disable")}</Button><Button size="sm" disabled={busy || Boolean(state.storageError)} onClick={() => void learning.update({ action: "remove", revision: state.revision, id: candidate.id })}>{featureText(locale, "Delete")}</Button></div>
      </div>)}
    </>}
  </section>;
}
