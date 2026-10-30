import type { AppLocale } from "../i18n/locales.ts";
import { featureText } from "../i18n/copy/features.ts";
import { useState } from "react";
import type { ShellExtras } from "../components/shell/ShellExtras";
import { artifactSubmissionPrompt, restoreArtifactFormDraft, validateArtifactValues, type ArtifactForm, type ArtifactFormDraft } from "./artifactForm";

export function useArtifactForm(form: ArtifactForm, source: string, artifactId: string, artifactForms: ShellExtras["artifactForms"], locale: AppLocale) {
  const key = `raytone-form:${JSON.stringify([artifactForms?.conversationId, artifactId])}`;
  const [draft, setDraft] = useState<ArtifactFormDraft>(() => {
    let raw = null; try { raw = localStorage.getItem(key); } catch {}
    return restoreArtifactFormDraft(source, raw);
  });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const outcome = artifactForms?.result(draft.requestId);
  const locked = busy || draft.submitted || !!outcome;
  const save = (next: ArtifactFormDraft) => { setDraft(next); try { localStorage.setItem(key, JSON.stringify(next)); setError(""); } catch { setError(featureText(locale, "Draft storage unavailable; input is kept on this page")); } };
  const submit = async () => {
    if (locked || !artifactForms) return;
    setBusy(true); setError("");
    try {
      const values = validateArtifactValues(form, draft.values, locale);
      // Persist identity before enqueue: an uncertain save/reply must retry with the same id.
      const sealed = { ...draft, values, submitted: true };
      localStorage.setItem(key, JSON.stringify(sealed));
      setDraft(sealed);
      await artifactForms.submit(draft.requestId, artifactSubmissionPrompt(form, values), artifactId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (busy || !artifactForms || !draft.submitted) return;
    setBusy(true); setError("");
    try { await artifactForms.submit(draft.requestId, artifactSubmissionPrompt(form, draft.values), artifactId); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return { draft, error, busy, outcome, locked, save, submit, retry };
}
