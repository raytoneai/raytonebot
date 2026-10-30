import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { featureText } from "../../i18n/copy/features.ts";

import { type SettingsCopy } from "../../i18n/copy/settings";
import { useLocale } from "../../i18n/LocaleContext";
import type { RoutineDefinitionPatch, RoutineRun, RoutineView } from "../../pi/routineTypes";
import { cronProblem, routineScheduleLabel, timezoneProblem } from "../../runtime/routineSchedule";
import type { RoutinesState } from "../../runtime/useRoutines";
import { useBotNames } from "../shell/ShellExtras";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { Dot, ProviderMark } from "./SettingsShared";

export function RoutinesSection({ t, state, initialBotId, onOpenConversation, drafts, onDraft }: {
  t: SettingsCopy; state: RoutinesState; initialBotId?: string; onOpenConversation?: ((conversationId: string, target?: Pick<RoutineRun, "runId" | "textId">) => void);
  drafts: Record<string, RoutineDefinitionPatch | undefined>; onDraft: (id: string, draft?: RoutineDefinitionPatch) => void;
}) {
  const botNames = useBotNames();
  const { locale } = useLocale();
  const [botId, setBotId] = useState(initialBotId ?? "all");
  const filtered = state.routines?.filter(routine => botId === "all" || (routine.botId ?? "assistant") === botId);
  const [expanded, setExpanded] = useState<string | undefined>(() => Object.keys(drafts).find(id => drafts[id]));
  return (
    <>
      <p className="settings-intro">{t.routines.intro.replaceAll("{assistant}", botNames.assistant)}</p>
      <p className="settings-note">{t.routines.clockNote}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{t.routines.loadFailed(state.error)}</p> : null}
      <div className="settings-memory-controls"><SelectMenu ariaLabel={featureText(locale, "Filter routines by Bot")} value={botId} onValueChange={setBotId}
        options={[{ value: "all", label: featureText(locale, "All Bots") }, ...Object.entries(botNames).map(([value, label]) => ({ value, label }))]} /></div>
      {filtered?.length === 0 ? <p className="settings-note">{t.routines.empty}</p> : null}
      <div className="settings-list">
        {(filtered ?? []).map((routine) => (
          <RoutineRow
            key={routine.id}
            t={t}
            routine={routine}
            draft={drafts[routine.id]}
            onDraft={draft => onDraft(routine.id, draft)}
            state={state}
            open={expanded === routine.id}
            onToggleOpen={() => setExpanded((current) => (current === routine.id ? undefined : routine.id))}
            onOpenConversation={onOpenConversation}
          />
        ))}
      </div>
    </>
  );
}

function RoutineRow({ t, routine, state, open, onToggleOpen, onOpenConversation, draft, onDraft }: {
  t: SettingsCopy;
  routine: RoutineView;
  state: RoutinesState;
  open: boolean;
  onToggleOpen: () => void;
  onOpenConversation?: ((conversationId: string, target?: Pick<RoutineRun, "runId" | "textId">) => void);
  draft?: RoutineDefinitionPatch;
  onDraft: (draft?: RoutineDefinitionPatch) => void;
}) {
  const c = t.routines;
  const botNames = useBotNames();
  const { locale } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const [customSchedule, setCustomSchedule] = useState(false);
  const busy = Boolean(state.busy);
  const failure = state.actionError?.id === routine.id ? state.actionError.message : undefined;
  const failureText = failure?.startsWith("This routine changed.")
    ? (draft && draft.revision !== (routine.revision ?? 0)
      ? (featureText(locale, "This routine changed elsewhere. Your draft is kept. Discard changes and edit again to load the latest version.")) : undefined) : failure;
  const last = routine.lastRun;
  const skipped = routine.lastSkipped && routine.lastSkipped.at > (last?.at ?? 0) ? routine.lastSkipped : undefined;
  const tone = !last ? "muted" : { running: "warn", success: "ok", error: "error", cancelled: "muted", interrupted: "warn" }[last.status];
  const when = last ? new Date(last.at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : undefined;
  const date = (at: number) => new Date(at).toLocaleString(locale, { timeZone: routine.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const running = last?.status === "running";
  const history = routine.history ?? (last ? [last] : []);
  const fields = (draft?.schedule ?? routine.schedule).trim().split(/\s+/);
  const simple = /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) && fields[2] === "*" && fields[3] === "*";
  const frequency = customSchedule || !simple ? "custom" : fields[4] === "*" ? "daily" : fields[4] === "1-5" ? "weekdays" : /^[0-7]$/.test(fields[4]) ? "weekly" : "custom";
  const time = simple ? `${fields[1].padStart(2, "0")}:${fields[0].padStart(2, "0")}` : "09:00";
  const problem = draft ? !draft.title.trim() ? (featureText(locale, "Enter a task name."))
    : !draft.instructions.trim() ? (featureText(locale, "Enter task instructions."))
    : cronProblem(draft.schedule) ? (featureText(locale, "Enter a valid five-field cron expression."))
    : timezoneProblem(draft.timezone) ? (featureText(locale, "Enter a valid time zone, such as Asia/Shanghai.")) : undefined : undefined;
  const changeSchedule = (kind: string, value = time, day = /^[0-7]$/.test(fields[4]) ? fields[4] : "1") => {
    if (!draft) return;
    setCustomSchedule(kind === "custom");
    if (kind === "custom") return;
    const [hour, minute] = value.split(":");
    if (hour === undefined || minute === undefined) return;
    onDraft({ ...draft, schedule: `${Number(minute)} ${Number(hour)} * * ${kind === "daily" ? "*" : kind === "weekdays" ? "1-5" : day}` });
  };

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row routine-row-header">
        <ProviderMark label={routine.title} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{routine.title}</strong></span>
          <span className="settings-row-sub settings-row-meta">
            <span>{botNames[routine.botId ?? "assistant"] ?? routine.botId}</span>
            <span title={routine.schedule}>{routineScheduleLabel(routine.schedule, locale)}</span><span>{routine.timezone}</span>
          </span>
        </button>
        <span className="settings-key-pill" data-tone={last?.waiting || skipped ? "warn" : tone}><Dot />{last?.waiting ? c.waiting : skipped ? (featureText(locale, "Not run")) : last ? c.status[last.status] : c.neverRun}</span>
        <Switch
          size="sm"
          aria-label={`${routine.title} ${c.enable}`}
          checked={routine.enabled}
          disabled={busy || Boolean(draft)}
          onCheckedChange={(checked) => void state.setEnabled(routine.id, checked)}
        />
        <button type="button" className="settings-chevron" aria-label={routine.title} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          {draft ? <form className="routine-edit-form" onSubmit={async event => { event.preventDefault(); if (!problem && !busy && !running && await state.update(routine.id, draft)) onDraft(); }}>
            <label className="settings-field">{featureText(locale, "Name")}<Input value={draft.title} maxLength={80} required disabled={busy} onChange={event => onDraft({ ...draft, title: event.target.value })} /></label>
            <label className="settings-field">{featureText(locale, "Instructions")}<textarea value={draft.instructions} rows={4} maxLength={4000} required disabled={busy} onChange={event => onDraft({ ...draft, instructions: event.target.value })} /></label>
            <div className="routine-schedule-fields">
              <label className="settings-field">{featureText(locale, "Repeat")}<select value={frequency} disabled={busy} onChange={event => changeSchedule(event.target.value)}>
                <option value="daily">{featureText(locale, "Daily")}</option><option value="weekdays">{featureText(locale, "Weekdays")}</option><option value="weekly">{featureText(locale, "Weekly")}</option><option value="custom">{featureText(locale, "Custom")}</option>
              </select></label>
              {frequency !== "custom" ? <label className="settings-field">{featureText(locale, "Time")}<input type="time" value={time} disabled={busy} onChange={event => changeSchedule(frequency, event.target.value)} /></label> : null}
              {frequency === "weekly" ? <label className="settings-field">{featureText(locale, "Day")}<select value={fields[4] === "7" ? "0" : fields[4]} disabled={busy} onChange={event => changeSchedule("weekly", time, event.target.value)}>
                {(locale === "ja" ? ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"] : locale === "zh" ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).map((label, value) => <option key={value} value={value}>{label}</option>)}
              </select></label> : null}
            </div>
            {frequency === "custom" ? <label className="settings-field">{featureText(locale, "Schedule (cron)")}<Input value={draft.schedule} maxLength={160} disabled={busy} placeholder="0 9 * * 1-5" onChange={event => onDraft({ ...draft, schedule: event.target.value })} /></label> : null}
            <label className="settings-field">{featureText(locale, "Time zone")}<Input value={draft.timezone} disabled={busy} maxLength={100} placeholder="Asia/Shanghai" onChange={event => onDraft({ ...draft, timezone: event.target.value })} /></label>
            <div className="settings-provider-actions"><Button type="submit" size="sm" disabled={busy || running || Boolean(problem)}>{busy ? (featureText(locale, "Saving…")) : (featureText(locale, "Save changes"))}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { onDraft(); setCustomSchedule(false); }}>{featureText(locale, "Discard changes")}</Button></div>
            <p className="settings-note" role="status">{problem ?? (running ? (featureText(locale, "Wait for this run to finish before saving.")) : featureText(locale, "Unsaved. Closing settings keeps this draft on this page."))}</p>
          </form> : <p className="settings-note routine-instructions">{routine.instructions}</p>}
          <p className="settings-note">{routine.enabled ? routine.nextRunAt ? `${featureText(locale, "Next planned")} ${date(routine.nextRunAt)} (${routine.timezone})`
            : (featureText(locale, "No matching time within the next year.")) : (featureText(locale, "Disabled; scheduled runs are paused."))}</p>
          {when ? <p className="settings-note">{featureText(locale, "Last run")} {date(last!.at)}</p> : null}
          {routine.lastSkipped ? <p className="settings-status" data-tone="warn" role="status">{date(routine.lastSkipped.at)} · {routine.lastSkipped.reason === "busy"
            ? (featureText(locale, "The host was busy. This occurrence was skipped and was not replayed."))
            : (featureText(locale, "The host missed this scheduled time. This occurrence was not replayed."))}</p> : null}
          {routine.disabledReason && !routine.enabled ? <span className="settings-status" data-tone="error"><Dot />{c.switchedOff(routine.disabledReason)}</span> : null}
          {last?.status === "error" && last.error && routine.enabled ? <span className="settings-status" data-tone="error"><Dot />{last.error}</span> : null}
          {last?.waiting ? <span className="settings-status" data-tone="warn" role="status"><Dot />{c.waitingNote}</span> : null}
          <div className="settings-provider-actions">
            {!draft ? <Button size="sm" variant="ghost" disabled={busy || running} onClick={() => { setCustomSchedule(false); onDraft({ title: routine.title, instructions: routine.instructions, schedule: routine.schedule, timezone: routine.timezone, revision: routine.revision ?? 0 }); }}>{featureText(locale, "Edit")}</Button> : null}
            <Button size="sm" disabled={busy || Boolean(draft) || !routine.enabled || running} title={routine.enabled ? undefined : c.turnOnFirst}
              onClick={() => void state.runNow(routine.id)}>{c.runNow}</Button>
            {onOpenConversation ? (
              <Button size="sm" variant="ghost" disabled={!last} onClick={() => onOpenConversation(routine.conversationId)}>{c.openConversation}</Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy || Boolean(draft)} onBlur={() => setConfirming(false)}
              onClick={() => { if (confirming) void state.remove(routine.id); else setConfirming(true); }}>
              {confirming ? c.confirmRemove : c.remove}
            </Button>
            {failureText ? <span className="settings-status" data-tone="error" role="status"><Dot />{failureText}</span> : null}
          </div>
          {history.length ? <div className="routine-history">
            <h4>{featureText(locale, "Run history")}</h4>
            <ol>{history.slice(0, allRuns ? history.length : 5).map(run => <li key={run.occurrenceId}>
              <div><time dateTime={new Date(run.at).toISOString()}>{date(run.at)}</time><span className="settings-key-pill" data-tone={run.status === "error" ? "error" : run.status === "success" ? "ok" : "muted"}>{run.waiting ? c.waiting : c.status[run.status]}</span>
                {onOpenConversation && (run.textId || run.runId) ? <Button size="sm" variant="ghost" onClick={() => onOpenConversation(routine.conversationId, run)}>{featureText(locale, "View result")}</Button> : null}</div>
              {run.error ? <p className="settings-note" data-tone="error">{run.error}</p> : null}
            </li>)}</ol>
            {history.length > 5 ? <Button size="sm" variant="ghost" onClick={() => setAllRuns(value => !value)}>{allRuns ? (featureText(locale, "Show less")) : (featureText(locale, "Show all {count} runs", { count: history.length }))}</Button> : null}
            <p className="settings-note">{featureText(locale, "The latest 20 runs are listed; full results stay in the conversation.")}</p>
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}
