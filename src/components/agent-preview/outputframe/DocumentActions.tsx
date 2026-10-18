import { useLocale } from "../../../i18n/LocaleContext";
import type { PiFileScope } from "../../../pi/piClient";
import { useWorkspaceDocument } from "../../../runtime/useWorkspaceDocument";
import { useShellExtras } from "../../shell/ShellExtras";
import type { OutputPanelItem } from "./panelItem";

/** Only the existing Output owner renders document controls. */
export function DocumentActions({ item, body, downloadUrl }: { item: OutputPanelItem; body: string; downloadUrl?: string }) {
  const { locale } = useLocale(); const zh = locale === "zh";
  const extras = useShellExtras();
  const { workspaceScope, workspaceSharedAvailable, onAttachWorkspaceFile, artifactForms } = extras;
  const d = useWorkspaceDocument(item, body, downloadUrl, extras, zh);
  if (!workspaceScope || !artifactForms) return null;
  return <div className="document-actions">
    <div className="document-toolbar">
      <button type="button" disabled={d.busy} onClick={() => d.setCopying(v => !v)}>{zh ? "另存为文档" : "Save as document"}</button>
      {d.scope && d.path && /\.(md|txt)$/i.test(d.path) ? <>
        <button type="button" disabled={d.busy || d.editing} onClick={() => void d.beginEdit()}>{zh ? "编辑文档" : "Edit document"}</button>
        <button type="button" disabled={d.busy || !onAttachWorkspaceFile} onClick={() => void d.attach()}>{zh ? "引用到输入框" : "Attach to composer"}</button>
      </> : null}
    </div>
    {d.copying ? <div className="document-copy-controls">
      <input aria-label={zh ? "文档文件名" : "Document filename"} value={d.name} maxLength={240} disabled={d.busy} onChange={e => d.setName(e.target.value)} />
      <select aria-label={zh ? "保存位置" : "Save location"} value={d.targetScope} disabled={d.busy} onChange={e => d.setTargetScope(e.target.value as PiFileScope)}><option value={workspaceScope}>{zh ? "当前成员工作区" : "Agent workspace"}</option>{workspaceSharedAvailable ? <option value="shared">{zh ? "共享工作区" : "Shared workspace"}</option> : null}</select>
      <button type="button" disabled={d.busy} onClick={() => void d.saveCopy()}>{zh ? "保存副本" : "Save copy"}</button>
    </div> : null}
    {d.editing && d.document ? <div className="document-editor">
      {d.document.source ? <small>{zh ? "来源" : "Source"}: {d.document.source.title ?? (zh ? "已关联来源对话" : "Linked conversation")}</small> : null}
      <textarea aria-label={zh ? "文档内容" : "Document content"} value={d.text} disabled={d.busy} maxLength={256 * 1024} rows={18} onChange={e => d.changeText(e.target.value)} />
      <button type="button" disabled={d.busy} onClick={() => void d.saveChanges()}>{zh ? "保存修改" : "Save changes"}</button>
      <button type="button" disabled={d.busy} onClick={() => d.setEditing(false)}>{zh ? "返回预览（保留草稿）" : "Preview (keep draft)"}</button>
      <button type="button" disabled={d.busy} onClick={() => void d.discard()}>{zh ? "放弃草稿，加载最新文件" : "Discard draft and load latest"}</button>
    </div> : null}
    {d.busy ? <p role="status">{zh ? "处理中…" : "Working…"}</p> : null}
    {d.error ? <p role="alert">{d.error}</p> : d.notice ? <p role="status">{d.notice}</p> : null}
  </div>;
}
