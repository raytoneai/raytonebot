import { useState } from "react";
import { featureText } from "../../i18n/copy/features.ts";

import { type SettingsCopy } from "../../i18n/copy/settings";
import { useLocale } from "../../i18n/LocaleContext";
import { MEMORY_COUNT_LIMIT, MEMORY_TEXT_LIMIT, type MemoryScope, type MemoryView } from "../../pi/memoryTypes";
import type { MemoriesState } from "../../runtime/useMemories";
import { useBotNames } from "../shell/ShellExtras";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { Dot } from "./SettingsShared";

export const memoryScopeKey = (scope?: MemoryScope) => !scope || scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
type MemoryScopeOption = { scope: MemoryScope; label: string; available: boolean };

export function MemorySection({ t, state, scopes = [], initialScope }: { t: SettingsCopy; state: MemoriesState; scopes?: { scope: MemoryScope; label: string }[]; initialScope?: MemoryScope }) {
  const c = t.memory;
  const { locale } = useLocale();
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState(initialScope ? memoryScopeKey(initialScope) : "all");
  const [addScope, setAddScope] = useState(memoryScopeKey(initialScope));
  const memory = state.memory;
  const options = new Map<string, MemoryScopeOption>([["global", { scope: { kind: "global" }, label: featureText(locale, "Global"), available: true }]]);
  for (const option of scopes) options.set(memoryScopeKey(option.scope), { ...option, available: true });
  for (const item of memory?.memories ?? []) {
    const scope = item.scope ?? { kind: "global" as const };
    if (!options.has(memoryScopeKey(scope))) options.set(memoryScopeKey(scope), { scope, label: scope.kind === "global" ? (featureText(locale, "Global"))
      : `${scope.kind === "bot" ? "Bot" : featureText(locale, "Group")} · ${scope.id} (${featureText(locale, "unavailable")})`, available: false });
  }
  const scopeOptions = [...options.values()];
  const available = scopeOptions.filter(option => option.available);
  const memories = [...(memory?.memories ?? [])].reverse().filter(item => filter === "all" || memoryScopeKey(item.scope) === filter);
  const addFailure = state.actionError?.id === "new" ? state.actionError.message : undefined;
  const selectedAddScope = available.find(option => memoryScopeKey(option.scope) === addScope)?.scope;
  const add = async () => { if (!state.busy && draft.trim() && selectedAddScope && await state.save(undefined, draft, selectedAddScope)) setDraft(""); };
  return (
    <>
      <p className="settings-intro">{featureText(locale, "Memories can be shared globally, with one Bot, or within one group. Chat saves default to the current Bot or group; global memories are available in every conversation.")}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{c.loadFailed(state.error)}</p> : null}
      {memory ? (
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row-main"><span className="settings-row-title"><strong>{c.enable}</strong></span>
              <span className="settings-row-sub">{c.count(memory.memories.length, MEMORY_COUNT_LIMIT)}</span></span>
            <Switch size="sm" aria-label={c.enable} checked={memory.enabled} disabled={Boolean(state.busy)}
              onCheckedChange={(checked) => void state.setEnabled(checked)} />
          </div>
        </div>
      ) : null}
      {memory ? <div className="settings-memory-controls">
        <SelectMenu ariaLabel={featureText(locale, "Filter memories by scope")} value={filter} onValueChange={setFilter}
          options={[{ value: "all", label: featureText(locale, "All scopes") }, ...scopeOptions.map(option => ({ value: memoryScopeKey(option.scope), label: option.label }))]} />
      </div> : null}
      {memory && !memory.enabled ? <p className="settings-status" data-tone="warn" role="note"><Dot />{c.off}</p> : null}
      {memory && memories.length === 0 ? <p className="settings-note">{filter === "all" ? c.empty : featureText(locale, "No memories in this scope.")}</p> : null}
      {memories.length ? (
        <div className="settings-list">
          {memories.map((item) => <MemoryRow key={item.id} t={t} memory={item} state={state} scopes={scopeOptions} />)}
        </div>
      ) : null}
      {memory ? (
        <div className="settings-field-row settings-memory-controls">
          <Input value={draft} disabled={Boolean(state.busy)} maxLength={MEMORY_TEXT_LIMIT} placeholder={c.addPlaceholder} aria-label={c.addPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void add(); }} />
          <SelectMenu ariaLabel={featureText(locale, "New memory scope")} value={addScope} onValueChange={setAddScope} disabled={Boolean(state.busy)}
            options={available.map(option => ({ value: memoryScopeKey(option.scope), label: option.label }))} />
          <Button size="sm" disabled={!draft.trim() || Boolean(state.busy) || !selectedAddScope} onClick={() => void add()}>{c.add}</Button>
        </div>
      ) : null}
      {addFailure ? <span className="settings-status" data-tone="error" role="status"><Dot />{c.failed(addFailure)}</span> : null}
    </>
  );
}

function MemoryRow({ t, memory, state, scopes }: { t: SettingsCopy; memory: MemoryView; state: MemoriesState; scopes: MemoryScopeOption[] }) {
  const c = t.memory;
  const { locale } = useLocale();
  const botNames = useBotNames();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [scopeKey, setScopeKey] = useState(memoryScopeKey(memory.scope));
  const [scopeChanged, setScopeChanged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = Boolean(state.busy);
  const failure = state.actionError?.id === memory.id ? state.actionError.message : undefined;
  const when = new Date(memory.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const selectedScope = scopes.find(option => memoryScopeKey(option.scope) === scopeKey);
  const validScope = !scopeChanged || selectedScope?.available;
  const scopeLabel = scopes.find(option => memoryScopeKey(option.scope) === memoryScopeKey(memory.scope))?.label;
  const reset = () => { setText(memory.text); setScopeKey(memoryScopeKey(memory.scope)); setScopeChanged(false); };
  const save = async () => { if (!busy && validScope && await state.save(memory.id, text, scopeChanged ? selectedScope?.scope : undefined)) setEditing(false); };
  return (
    <div className="settings-row settings-memory-row">
      <span className="settings-row-main">
        {editing ? (
          <Input value={text} maxLength={MEMORY_TEXT_LIMIT} autoFocus disabled={busy} aria-label={c.edit} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); reset(); setEditing(false); }
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
            }} />
        ) : <span className="settings-row-title">{memory.text}</span>}
        {editing ? <SelectMenu ariaLabel={featureText(locale, "Memory scope")} value={scopeKey} disabled={busy}
          onValueChange={value => { setScopeKey(value); setScopeChanged(value !== memoryScopeKey(memory.scope)); }}
          options={scopes.map(option => ({ value: memoryScopeKey(option.scope), label: option.label, disabled: !option.available }))} /> : null}
        <span className="settings-row-sub">{scopeLabel} · {memory.source ? c.savedBy(botNames[memory.source.botId ?? memory.source.agent] ?? botNames[memory.source.agent], when) : c.addedByYou(when)}</span>
        {failure ? <span className="settings-status" data-tone="error" role="status"><Dot />{c.failed(failure)}</span> : null}
      </span>
      {editing ? (
        <>
          <Button size="sm" disabled={busy || !text.trim() || !validScope} onClick={() => void save()}>{c.save}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { reset(); setEditing(false); }}>{c.cancel}</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { reset(); setEditing(true); }}>{c.edit}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onBlur={() => setConfirming(false)}
            onClick={() => { if (confirming) void state.remove(memory.id); else setConfirming(true); }}>
            {confirming ? c.confirmRemove : c.remove}
          </Button>
        </>
      )}
    </div>
  );
}
