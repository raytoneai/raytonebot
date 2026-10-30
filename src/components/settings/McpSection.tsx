import { ChevronDown, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { type SettingsCopy } from "../../i18n/copy/settings";
import type { McpServerView } from "../../pi/mcpTypes";
import type { McpServersState } from "../../runtime/useMcpServers";
import { Button, Input, Switch } from "../ui";
import { Dot, Field, hostOf, MASK, ProviderMark } from "./SettingsShared";

export function McpSection({ t, state }: { t: SettingsCopy; state: McpServersState }) {
  const [expanded, setExpanded] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <p className="settings-intro">{t.mcp.intro}</p>
      <p className="settings-note">{t.mcp.approvalNote} {t.mcp.codexNote}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{t.mcp.loadFailed(state.error)}</p> : null}
      {state.servers?.length === 0 && !adding ? <p className="settings-note">{t.mcp.empty}</p> : null}
      <div className="settings-list">
        {(state.servers ?? []).map((server) => (
          <McpRow
            key={server.id}
            t={t}
            server={server}
            state={state}
            open={expanded === server.id}
            onToggleOpen={() => setExpanded((current) => (current === server.id ? undefined : server.id))}
          />
        ))}
        {adding ? <McpRow t={t} state={state} open onToggleOpen={() => setAdding(false)} onAdded={() => setAdding(false)} /> : null}
      </div>
      {!adding ? (
        <button type="button" className="settings-text-button" onClick={() => setAdding(true)}>
          <Plus size={14} aria-hidden="true" />{t.mcp.add}
        </button>
      ) : null}
    </>
  );
}

function McpRow({ t, server, state, open, onToggleOpen, onAdded }: {
  t: SettingsCopy;
  server?: McpServerView;
  state: McpServersState;
  open: boolean;
  onToggleOpen: () => void;
  onAdded?: () => void;
}) {
  const c = t.mcp;
  const key = server?.id ?? "new";
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [token, setToken] = useState("");
  const [confirming, setConfirming] = useState(false);
  const busy = Boolean(state.busy);
  const failure = state.actionError?.id === key ? state.actionError.message : undefined;
  const title = server?.name ?? c.newServer;
  const tone = !server ? "muted" : { off: "muted", ready: "ok", error: "error" }[server.status];
  const host = server ? hostOf(server.url) : "";
  const save = async () => {
    const saved = await state.save(server?.id, { name, url, ...(token.trim() ? { token } : {}) });
    if (saved) { setToken(""); onAdded?.(); }
  };

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row">
        <ProviderMark label={title} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{title}</strong></span>
          {server ? (
            <span className="settings-row-sub settings-row-meta"><span>{host}</span><span>{server.status === "ready" ? c.tools(server.tools.length) : server.error ?? c.state[server.status]}</span></span>
          ) : null}
        </button>
        {server ? (
          <>
            <span className="settings-key-pill" data-tone={tone}><Dot />{c.state[server.status]}</span>
            <Switch
              size="sm"
              aria-label={`${server.name} ${c.enable}`}
              checked={server.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void state.save(server.id, { enabled: checked })}
            />
          </>
        ) : null}
        <button type="button" className="settings-chevron" aria-label={title} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <Field label={c.name}>
            <Input value={name} maxLength={40} spellCheck={false} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={c.url} hint={c.urlHint}>
            <Input value={url} type="url" spellCheck={false} autoComplete="off" placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <Field label={c.token} hint={c.tokenHint}>
            <div className="settings-field-row">
              <Input type="password" autoComplete="off" spellCheck={false} value={token}
                placeholder={server?.hasToken ? MASK : c.tokenEmpty} onChange={(event) => setToken(event.target.value)} />
              {server?.hasToken && !token ? <span className="settings-status" data-tone="ok"><Dot />{c.tokenSaved}</span> : null}
            </div>
          </Field>
          {server && server.tools.length > 0 ? (
            <p className="settings-note">{server.tools.map((tool) => <code key={tool}>{tool}</code>).reduce<ReactNode[]>((all, item) => all.length ? [...all, " ", item] : [item], [])}</p>
          ) : server?.status === "ready" ? <p className="settings-note">{c.noTools}</p> : null}
          {server?.status === "error" && server.error ? <span className="settings-status" data-tone="error"><Dot />{server.error}</span> : null}
          <div className="settings-provider-actions">
            <Button size="sm" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>{state.busy === key ? c.saving : c.save}</Button>
            {server ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy || !server.enabled} onClick={() => void state.refresh(server.id)}>{c.refresh}</Button>
                {server.hasToken ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void state.save(server.id, { clearToken: true })}>{c.clearToken}</Button> : null}
                <Button size="sm" variant="ghost" disabled={busy} onBlur={() => setConfirming(false)}
                  onClick={() => { if (confirming) void state.remove(server.id); else setConfirming(true); }}>
                  {confirming ? c.confirmRemove : c.remove}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleOpen}>{c.cancel}</Button>
            )}
            {failure ? <span className="settings-status" data-tone="error" role="status"><Dot />{c.saveFailed(failure)}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
