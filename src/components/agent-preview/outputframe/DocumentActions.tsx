import { featureText } from "../../../i18n/copy/features.ts";
import { useLocale } from "../../../i18n/LocaleContext";
import type { PiFileScope } from "../../../pi/piClient";
import { useWorkspaceDocument } from "../../../runtime/useWorkspaceDocument";
import { useShellExtras } from "../../shell/ShellExtras";
import type { OutputPanelItem } from "./panelItem";

/** Only the existing Output owner renders document controls. */
export function DocumentActions({ item, body, downloadUrl }: { item: OutputPanelItem; body: string; downloadUrl?: string }) {
  const { locale } = useLocale();
  const extras = useShellExtras();
  const { workspaceScope, workspaceSharedAvailable, onAttachWorkspaceFile, artifactForms } = extras;
  const d = useWorkspaceDocument(item, body, downloadUrl, extras, locale);
  if (!workspaceScope || !artifactForms) return null;
  return <div className="document-actions">
    <div className="document-toolbar">
      <button type="button" disabled={d.busy} onClick={() => d.setCopying(v => !v)}>{featureText(locale, "Save as document")}</button>
      {d.scope && d.path && /\.(md|txt)$/i.test(d.path) ? <>
        <button type="button" disabled={d.busy || d.editing} onClick={() => void d.beginEdit()}>{featureText(locale, "Edit document")}</button>
        <button type="button" disabled={d.busy || !onAttachWorkspaceFile} onClick={() => void d.attach()}>{featureText(locale, "Attach to composer")}</button>
      </> : null}
    </div>
    {d.copying ? <div className="document-copy-controls">
      <input aria-label={featureText(locale, "Document filename")} value={d.name} maxLength={240} disabled={d.busy} onChange={e => d.setName(e.target.value)} />
      <select aria-label={featureText(locale, "Save location")} value={d.targetScope} disabled={d.busy} onChange={e => d.setTargetScope(e.target.value as PiFileScope)}><option value={workspaceScope}>{featureText(locale, "Agent workspace")}</option>{workspaceSharedAvailable ? <option value="shared">{featureText(locale, "Shared workspace")}</option> : null}</select>
      <button type="button" disabled={d.busy} onClick={() => void d.saveCopy()}>{featureText(locale, "Save copy")}</button>
    </div> : null}
    {d.editing && d.document ? <div className="document-editor">
      {d.document.source ? <small>{featureText(locale, "Source")}: {d.document.source.title ?? (featureText(locale, "Linked conversation"))}</small> : null}
      <textarea aria-label={featureText(locale, "Document content")} value={d.text} disabled={d.busy} maxLength={256 * 1024} rows={18} onChange={e => d.changeText(e.target.value)} />
      <button type="button" disabled={d.busy} onClick={() => void d.saveChanges()}>{featureText(locale, "Save changes")}</button>
      <button type="button" disabled={d.busy} onClick={() => d.setEditing(false)}>{featureText(locale, "Preview (keep draft)")}</button>
      <button type="button" disabled={d.busy} onClick={() => void d.discard()}>{featureText(locale, "Discard draft and load latest")}</button>
    </div> : null}
    {d.busy ? <p role="status">{featureText(locale, "Working…")}</p> : null}
    {d.error ? <p role="alert">{d.error}</p> : d.notice ? <p role="status">{d.notice}</p> : null}
  </div>;
}
