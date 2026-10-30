import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { vaultCopy } from "../../i18n/copy/vault";
import { useLocale } from "../../i18n/LocaleContext";
import type { VaultLoginInput, VaultLoginView } from "../../pi/vaultTypes";
import type { VaultSettingsState } from "../../runtime/useVault";
import { Button, Input, Switch } from "../ui";
import { Field, MASK } from "./SettingsShared";

export function VaultSection({ state }: { state: VaultSettingsState }) {
  const { locale } = useLocale();
  const c = vaultCopy[locale];
  const [editing, setEditing] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const busy = Boolean(state.busy);
  return (
    <>
      <p className="settings-intro">{c.intro}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status">{c.loadFailed}</p> : null}
      {!state.state && !state.error ? <p className="settings-note" role="status">{c.loading}</p> : null}
      {state.state?.items.length === 0 && editing !== "new" ? <p className="settings-note">{c.empty}</p> : null}
      {(state.state?.items.length || editing === "new") ? <div className="settings-list">
        {(state.state?.items ?? []).map((item) => (
          <div className="settings-provider" key={item.id} data-open={editing === item.id}>
            <div className="settings-row settings-vault-row">
              <span className="settings-row-main">
                <span className="settings-row-title"><strong>{item.label}</strong><span className="settings-chip">{item.enabled ? c.enabled : c.disabled}</span></span>
                <span className="settings-row-sub">{item.origin}</span>
                <span className="settings-row-sub">{item.usernameHint}</span>
              </span>
              <Button size="sm" variant="ghost" disabled={busy || Boolean(editing)} onClick={() => { setEditing(item.id); setConfirming(undefined); }}>{c.edit}</Button>
              <Button size="sm" variant="ghost" disabled={busy || Boolean(editing)} onBlur={() => setConfirming(undefined)} onClick={async () => {
                if (confirming !== item.id) { setConfirming(item.id); return; }
                if (await state.remove(item.id)) setConfirming(undefined);
              }}>{confirming === item.id ? c.confirmRemove : c.remove}</Button>
            </div>
            {editing === item.id ? <VaultEditor item={item} state={state} onClose={() => setEditing(undefined)} /> : null}
            {editing !== item.id && state.actionError?.id === item.id ? <p className="settings-status settings-provider-editor" data-tone="error" role="alert">{c.failed}</p> : null}
          </div>
        ))}
        {editing === "new" ? <div className="settings-provider" data-open><VaultEditor state={state} onClose={() => setEditing(undefined)} /></div> : null}
      </div> : null}
      <div className="settings-provider-actions settings-vault-actions">
        <Button size="sm" variant="ghost" disabled={busy || Boolean(editing) || !state.state} onClick={() => { setEditing("new"); setConfirming(undefined); }}><Plus size={14} aria-hidden="true" />{c.add}</Button>
        {state.error ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void state.refresh()}>{c.refresh}</Button> : null}
      </div>
    </>
  );
}

function VaultEditor({ item, state, onClose }: { item?: VaultLoginView; state: VaultSettingsState; onClose: () => void }) {
  const { locale } = useLocale();
  const c = vaultCopy[locale];
  const [label, setLabel] = useState(item?.label ?? "");
  const [origin, setOrigin] = useState(item?.origin ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const busy = Boolean(state.busy);
  const key = item?.id ?? "new";
  let validOrigin = false;
  let originChanged = false;
  try {
    const url = new URL(origin.trim());
    validOrigin = url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    originChanged = Boolean(item && url.origin !== item.origin);
  } catch { /* Report invalid input inline. */ }
  const needsCredentials = !item || originChanged;
  const valid = Boolean(label.trim()) && validOrigin && (!needsCredentials || (username.length > 0 && password.length > 0));
  const save = async () => {
    if (!valid || busy) return;
    const input: VaultLoginInput = { id: item?.id, label: label.trim(), origin: origin.trim(), enabled,
      ...(username.length ? { username } : {}), ...(password.length ? { password } : {}) };
    if (await state.save(input) && mounted.current) { setUsername(""); setPassword(""); onClose(); }
  };
  const cancel = () => { setUsername(""); setPassword(""); onClose(); };
  return (
    <div className="settings-provider-editor" role="group" aria-label={item ? c.edit : c.newLogin}>
      <Field label={c.label}><Input aria-label={c.label} autoFocus autoComplete="off" value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} /></Field>
      <Field label={c.origin} hint={c.originHint}><Input aria-label={c.origin} type="url" autoComplete="off" spellCheck={false} placeholder="https://example.com" value={origin} disabled={busy} invalid={Boolean(origin) && !validOrigin} onChange={(event) => setOrigin(event.target.value)} /></Field>
      {origin && !validOrigin ? <p className="settings-status" data-tone="error">{c.invalidOrigin}</p> : null}
      {originChanged && validOrigin ? <p className="settings-note" role="status">{c.originChangeHint}</p> : null}
      <Field label={c.username} hint={!needsCredentials ? c.keepHint : undefined}><Input aria-label={c.username} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={username} placeholder={!needsCredentials ? item?.usernameHint : undefined} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></Field>
      <Field label={c.password} hint={!needsCredentials ? c.keepHint : undefined}><Input aria-label={c.password} type="password" autoComplete="off" spellCheck={false} value={password} placeholder={!needsCredentials ? MASK : undefined} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></Field>
      <div className="settings-provider-actions"><Switch size="sm" aria-label={c.enabled} checked={enabled} disabled={busy} onCheckedChange={setEnabled} /><span className="settings-note">{enabled ? c.enabled : c.disabled}</span></div>
      <p className="settings-note">{c.draftHint}</p>
      <div className="settings-provider-actions">
        <Button size="sm" disabled={!valid || busy} onClick={() => void save()}>{state.busy === key ? c.saving : c.save}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>{c.cancel}</Button>
      </div>
      {state.actionError?.id === key ? <p className="settings-status" data-tone="error" role="alert">{c.failed}</p> : null}
    </div>
  );
}
