import type { AppLocale } from "../i18n/locales.ts";
import { featureText } from "../i18n/copy/features.ts";
import { useEffect, useRef, useState } from "react";
import { piFileDownloadUrl, readPiDocument, savePiDocument, type PiDocument, type PiFileScope } from "../pi/piClient";
import type { ShellExtras } from "../components/shell/ShellExtras";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem";

export function useWorkspaceDocument(item: OutputPanelItem, body: string, downloadUrl: string | undefined, extras: ShellExtras, locale: AppLocale) {
  const { workspaceScope, workspaceSharedAvailable, onAttachWorkspaceFile, onOpenFile, artifactForms } = extras;
  const [editing, setEditing] = useState(false), [copying, setCopying] = useState(false), [busy, setBusy] = useState(false);
  const [document, setDocument] = useState<PiDocument>(), [text, setText] = useState(body), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [name, setName] = useState(/\.(md|txt)$/i.test(item.title) ? item.title.split("/").pop()! : `${item.title.replace(/\.[^.]+$/, "") || "Document"}.md`);
  const [targetScope, setTargetScope] = useState<PiFileScope>(workspaceSharedAvailable ? "shared" : workspaceScope ?? "assistant");
  const params = downloadUrl?.startsWith("/__agentcanvas/pi/files/download?") ? new URLSearchParams(downloadUrl.split("?")[1]) : undefined;
  const scope = params?.get("scope") as PiFileScope | undefined, path = params?.get("path");
  const key = `raytone-document:${JSON.stringify([scope, path])}`;
  const owner = artifactForms?.conversationId, currentOwner = useRef(owner), live = useRef(true);
  currentOwner.current = owner;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const stillHere = () => live.current && owner === currentOwner.current;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { if (stillHere()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (stillHere()) setBusy(false); }
  };
  const open = (doc: PiDocument) => { if (stillHere()) onOpenFile?.({ id: `workspace:${doc.scope}:${doc.path}`, kind: "file", title: doc.name, subtitle: doc.path, downloadUrl: piFileDownloadUrl(doc.scope, doc.path), revision: doc.version }); };
  const beginEdit = () => run(async () => {
    if (!scope || !path) return;
    const doc = await readPiDocument(scope, path); if (!stillHere()) return;
    setDocument(doc); setText(doc.content); setEditing(true);
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      if (typeof saved?.text === "string" && saved.text.length <= 256 * 1024 && /^[a-f0-9]{64}$/.test(saved.version)) {
        setText(saved.text); setDocument({ ...doc, version: saved.version });
        if (saved.version !== doc.version) setError(featureText(locale, "File changed; restored edits are kept. Review and reopen the latest version."));
      }
    } catch {}
  });
  const changeText = (value: string) => {
    setText(value);
    if (document) try { localStorage.setItem(key, JSON.stringify({ text: value, version: document.version })); }
    catch { setError(featureText(locale, "Draft storage unavailable; edits remain on this page")); }
  };
  const attach = () => run(async () => {
    if (!scope || !path) return;
    if (scope !== "shared" && scope !== workspaceScope) throw new Error(featureText(locale, "Save to the shared workspace before attaching to another member"));
    const doc = await readPiDocument(scope, path); if (!stillHere()) return;
    await onAttachWorkspaceFile?.(doc);
    if (stillHere()) setNotice(featureText(locale, "Attached to the composer; the next turn reads the latest file"));
  });
  const saveCopy = () => run(async () => {
    const doc = await savePiDocument({ scope: targetScope, name, content: editing ? text : body, conversationId: owner, artifactId: item.artifactId });
    if (!stillHere()) return; setCopying(false); setNotice(featureText(locale, "Document saved")); open(doc);
  });
  const saveChanges = () => run(async () => {
    if (!document) return;
    const doc = await savePiDocument({ scope: document.scope, path: document.path, content: text, version: document.version });
    // Do not delete a newer edit typed while the save request was in flight.
    try { const draft = JSON.parse(localStorage.getItem(key) ?? "null"); if (draft?.text === text && draft?.version === document.version) localStorage.removeItem(key); } catch {}
    if (!stillHere()) return; setDocument(doc); setEditing(false); setNotice(featureText(locale, "Saved")); open(doc);
  });
  const discard = () => run(async () => {
    if (!document) return;
    const doc = await readPiDocument(document.scope, document.path); if (!stillHere()) return;
    setDocument(doc); setText(doc.content); try { localStorage.removeItem(key); } catch {}
  });
  return { scope, path, editing, setEditing, copying, setCopying, busy, document, text, changeText, error, notice, name, setName, targetScope, setTargetScope, beginEdit, attach, saveCopy, saveChanges, discard };
}
