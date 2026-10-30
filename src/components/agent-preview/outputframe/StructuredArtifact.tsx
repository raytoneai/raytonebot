import { featureText } from "../../../i18n/copy/features.ts";
import { useShellExtras } from "../../shell/ShellExtras";
import { useLocale } from "../../../i18n/LocaleContext";
import type { ArtifactForm } from "../../../runtime/artifactForm";
import { useArtifactForm } from "../../../runtime/useArtifactForm";

/** Rendered only by Output; generated scripts never own these submit controls. */
export function StructuredArtifact({ form, source, artifactId }: { form: ArtifactForm; source: string; artifactId: string }) {
  const { artifactForms } = useShellExtras();
  const { locale } = useLocale();
  const { draft, error, busy, outcome, locked, save, submit, retry } = useArtifactForm(form, source, artifactId, artifactForms, locale);
  const labels = { queued: featureText(locale, "Queued"), running: featureText(locale, "Running"), completed: featureText(locale, "Completed"), failed: featureText(locale, "Failed or stopped; review the result first") };
  return <form className="structured-artifact" data-submission-id={draft.requestId} onSubmit={e => { e.preventDefault(); void submit(); }}>
    <h3>{form.title}</h3>
    {form.fields.map(field => <label key={field.id} style={{ display: "grid", gap: 6, marginBlock: 14 }}>
      <span>{field.label}{field.required ? " *" : ""}</span>
      {field.type === "select" ? <select disabled={locked} value={String(draft.values[field.id] ?? "")} onChange={e => save({ ...draft, values: { ...draft.values, [field.id]: e.target.value } })}><option value="">—</option>{field.options!.map(value => <option key={value}>{value}</option>)}</select> : <input disabled={locked} type={field.type === "boolean" ? "checkbox" : field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} min={field.min} max={field.max} maxLength={1000} checked={field.type === "boolean" ? draft.values[field.id] === true : undefined} value={field.type === "boolean" ? undefined : String(draft.values[field.id] ?? "")} onChange={e => save({ ...draft, values: { ...draft.values, [field.id]: field.type === "boolean" ? e.target.checked : field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value } })} />}
    </label>)}
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" disabled={locked || !artifactForms}>{featureText(locale, "Submit to conversation")}</button>
    {draft.submitted || outcome ? <p role="status">{outcome ? labels[outcome] : featureText(locale, "Submission recorded; check the conversation or queue")}</p> : null}
    {error && draft.submitted && !outcome ? <button type="button" disabled={busy} onClick={() => void retry()}>{featureText(locale, "Retry enqueue")}</button> : null}
    {outcome && outcome !== "queued" ? <button type="button" onClick={() => artifactForms?.openResult(draft.requestId)}>{featureText(locale, "View result")}</button> : null}
    {locked && !busy ? <button type="button" onClick={() => save({ ...draft, requestId: `form_${crypto.randomUUID()}`, submitted: false })}>{featureText(locale, "New submission")}</button> : null}
  </form>;
}
