import { Check, ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

import { type SettingsCopy } from "../../i18n/copy/settings";
import { type PiRuntimeState } from "../../pi/piClient";
import { providerIsAdded, providerValidationIssue, type ProviderPatch } from "../../runtime/providerSettings";
import { useProviderProbe } from "../../runtime/useProviderProbe";
import type { ProviderSettingsStatus } from "../../runtime/useProviderSettings";
import { defaultProviderConnection, type AgentFrontendProject, type ProviderConnection, type ProviderConnectionId, } from "../../schema/agentuxConfig";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { ModelOptionsEditor } from "./ModelOptionsEditor";
import { Dot, Field, hostOf, MASK, ProviderMark } from "./SettingsShared";

type ProvidersSectionProps = {
  t: SettingsCopy;
  project: AgentFrontendProject;
  runtime?: PiRuntimeState;
  sessionKeys: Record<string, string>;
  onSessionKeyChange: (id: ProviderConnectionId, value: string) => void;
  onUpdateProvider: (id: ProviderConnectionId, patch: ProviderPatch) => void;
  onSetDefaultProvider: (id: ProviderConnectionId) => void;
  isRunning: boolean;
  providerSettingsStatus?: ProviderSettingsStatus;
  probeRevision?: number;
  savedProviderSettings?: import("../../pi/piClient").ProviderSettingsView;
  removeKeys?: string[];
  onToggleRemoveKey?: (id: string) => void;
};

export function ProvidersSection({
  t, project, runtime, sessionKeys, onSessionKeyChange, onUpdateProvider, onSetDefaultProvider, isRunning, providerSettingsStatus = "idle", probeRevision, savedProviderSettings, removeKeys = [], onToggleRemoveKey,
}: ProvidersSectionProps) {
  const [expanded, setExpanded] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const enabled = project.providers.connections.filter((provider) => provider.enabled);
  const added = project.providers.connections.filter(providerIsAdded);
  const available = project.providers.connections.filter((provider) => !providerIsAdded(provider));
  const defaultId = defaultProviderConnection(project).id;

  return (
    <>
      {providerSettingsStatus === "load-failed" || providerSettingsStatus === "save-failed" ? <p className="settings-status" data-tone="error" role="status">
        {t.providers.persistence[providerSettingsStatus]}
      </p> : null}
      <div className="settings-list">
        {added.map((provider) => (
          <ProviderRow
            key={provider.id}
            t={t}
            provider={provider}
            isDefault={provider.id === defaultId}
            onlyOne={enabled.length === 1}
            open={expanded === provider.id}
            onToggleOpen={() => setExpanded((current) => (current === provider.id ? undefined : provider.id))}
            sessionKey={sessionKeys[provider.id] ?? ""}
            savedKey={Boolean(savedProviderSettings?.credentials[provider.id] && savedProviderSettings.providers?.connections.some(p => p.id === provider.id && p.baseUrl.replace(/\/+$/, "") === provider.baseUrl.replace(/\/+$/, "") && p.protocol === provider.protocol && p.auth.mode === provider.auth.mode))}
            removingKey={removeKeys.includes(provider.id)}
            onToggleRemoveKey={onToggleRemoveKey ? () => onToggleRemoveKey(provider.id) : undefined}
            runtime={runtime}
            isRunning={isRunning}
            probeRevision={probeRevision}
            onSessionKeyChange={(value) => onSessionKeyChange(provider.id, value)}
            onUpdate={(patch) => onUpdateProvider(provider.id, patch)}
            onSetDefault={() => onSetDefaultProvider(provider.id)}
          />
        ))}
      </div>
      {adding ? (
        <div className="settings-add" ref={(node) => node?.scrollIntoView({ block: "nearest", behavior: "smooth" })}>
          <div className="settings-add-head">
            <div>
              <strong>{t.providers.addTitle}</strong>
              <p className="settings-row-sub">{t.providers.addHint}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t.providers.cancel}</Button>
          </div>
          <div className="settings-tiles">
            {available.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className="settings-tile"
                disabled={provider.enabled}
                onClick={() => {
                  onUpdateProvider(provider.id, { enabled: true, added: true });
                  setExpanded(provider.id);
                  setAdding(false);
                }}
              >
                <ProviderMark label={provider.label} />
                <span className="settings-tile-name">{provider.label}</span>
                <span className="settings-tile-sub">{provider.enabled ? t.providers.added : hostOf(provider.baseUrl)}</span>
                {provider.enabled ? <Check className="settings-tile-check" size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : available.length > 0 ? (
        <button type="button" className="settings-text-button" onClick={() => setAdding(true)}>
          <Plus size={14} aria-hidden="true" />{t.providers.add}
        </button>
      ) : null}
    </>
  );
}

function ProviderRow({
  t, provider, isDefault, onlyOne, open, onToggleOpen, sessionKey, runtime, isRunning, onSessionKeyChange, onUpdate, onSetDefault, probeRevision, savedKey, removingKey, onToggleRemoveKey,
}: {
  t: SettingsCopy;
  provider: ProviderConnection;
  isDefault: boolean;
  onlyOne: boolean;
  open: boolean;
  onToggleOpen: () => void;
  savedKey?: boolean;
  removingKey?: boolean;
  onToggleRemoveKey?: () => void;
  sessionKey: string;
  runtime?: PiRuntimeState;
  isRunning: boolean;
  onSessionKeyChange: (value: string) => void;
  onUpdate: (patch: ProviderPatch) => void;
  onSetDefault: () => void;
  probeRevision?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const invalid = providerValidationIssue(provider);
  const { test, runTest } = useProviderProbe(provider, sessionKey, onUpdate, probeRevision);
  const envVar = provider.auth.mode === "env" ? provider.auth.envVar : "";
  const envSet = Boolean(envVar && runtime?.envKeys?.includes(envVar));
  const keyState = provider.auth.mode === "none"
    ? { tone: "muted", label: t.providers.keyNone }
    : sessionKey
      ? { tone: "ok", label: t.providers.keyPending }
      : removingKey
        ? { tone: "warn", label: t.providers.keyRemovePending }
      : savedKey
        ? { tone: "ok", label: t.providers.keySaved }
      : envSet
        ? { tone: "ok", label: `${MASK.slice(0, 4)} ${t.providers.keyEnv}` }
        : { tone: "warn", label: t.providers.keyMissing };
  const models = [...new Set([provider.defaultModel, ...provider.models])];

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row settings-model-row">
        <ProviderMark label={provider.label} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title">
            <strong>{provider.label}</strong>
            {isDefault ? <span className="settings-chip" data-tone="accent">{t.providers.default}</span> : null}
            {!provider.enabled ? <span className="settings-chip">{t.providers.disabled}</span> : null}
          </span>
          <span className="settings-row-sub settings-row-meta">
            <span>{hostOf(provider.baseUrl)}</span><span>{provider.defaultModel}</span>
          </span>
        </button>
        <span className="settings-key-pill" data-tone={keyState.tone}><Dot />{keyState.label}</span>
        <Switch
          size="sm"
          aria-label={`${t.providers.enabled} ${provider.label}`}
          checked={provider.enabled}
          disabled={(provider.enabled && (onlyOne || isDefault)) || isRunning}
          title={isRunning ? t.providers.runningHint : isDefault ? t.providers.defaultHint : onlyOne && provider.enabled ? t.providers.keepOne : undefined}
          onCheckedChange={(checked) => onUpdate({ enabled: checked, added: true })}
        />
        <button type="button" className="settings-chevron" aria-label={provider.label} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <Field label={t.providers.baseUrl}>
            <Input value={provider.baseUrl} invalid={invalid === "baseUrl"} spellCheck={false} autoComplete="off" onChange={(event) => onUpdate({ baseUrl: event.target.value })} />
          </Field>
          {provider.auth.mode !== "none" ? (
            <>
              <Field label={t.providers.envVar}>
                <div className="settings-field-row">
                  <Input
                    value={envVar}
                    invalid={invalid === "authEnvVar"}
                    spellCheck={false}
                    onChange={(event) => onUpdate({ authEnvVar: event.target.value })}
                  />
                  <span className="settings-status" data-tone={envSet ? "ok" : "muted"}>
                    <Dot />{envSet ? t.providers.envFound : t.providers.envMissing}
                  </span>
                </div>
              </Field>
              <Field label={t.providers.sessionKey} hint={removingKey ? t.providers.keyRemoving : savedKey ? t.providers.keySavedHint : envSet && !sessionKey ? t.providers.envKeyHint : t.providers.sessionKeyHint}>
                <div className="settings-field-row">
                  <Input
                    type={revealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={savedKey && !removingKey ? t.providers.keySaved : t.providers.sessionKeyPlaceholder}
                    value={sessionKey}
                    onChange={(event) => onSessionKeyChange(event.target.value.trim())}
                  />
                  {envSet && !sessionKey ? <span className="settings-status" data-tone="ok"><Dot />{t.providers.envKeySet}</span> : null}
                  {savedKey && onToggleRemoveKey ? <Button size="sm" variant="ghost" onClick={onToggleRemoveKey}>{removingKey ? t.providers.keyUndoRemove : t.providers.keyRemove}</Button> : null}
                  <Button size="sm" variant="ghost" disabled={!sessionKey} onClick={() => setRevealed((value) => !value)}>
                    {revealed ? t.providers.hide : t.providers.show}
                  </Button>
                </div>
              </Field>
            </>
          ) : null}
          <Field label={t.providers.defaultModel}>
            <div className="settings-field-row">
              {manualModel ? <Input value={provider.defaultModel} aria-label={t.providers.defaultModel} maxLength={256} invalid={invalid === "defaultModel"}
                spellCheck={false} onChange={(event) => onUpdate({ defaultModel: event.target.value })} /> : <SelectMenu
                ariaLabel={t.providers.defaultModel}
                value={provider.defaultModel}
                options={models.map((model) => ({ value: model, label: model }))}
                onValueChange={(value) => onUpdate({ defaultModel: value })}
              />}
              <Button size="sm" variant="ghost" onClick={() => setManualModel(value => !value)}>{manualModel ? t.providers.chooseModel : t.providers.manualModel}</Button>
              <Button size="sm" variant="ghost" disabled={test === "running" || Boolean(invalid)} onClick={() => void runTest()}>
                {t.providers.fetchModels}
              </Button>
            </div>
          </Field>
          <ModelOptionsEditor provider={provider} onChange={modelOptions => onUpdate({ modelOptions })} />
          <div className="settings-provider-actions">
            <Button size="sm" disabled={test === "running" || Boolean(invalid)} onClick={() => void runTest(false)}>
              {test === "running" ? t.providers.testing : t.providers.test}
            </Button>
            {test && test !== "running" ? (
              <span className="settings-status" data-tone={test.ok ? "ok" : "error"} role="status">
                <Dot />
                {test.ok
                  ? t.providers.testOk(test.latencyMs ?? 0, test.models.length)
                  : t.providers.testFail(test.error ?? `HTTP ${test.status ?? "?"}`)}
              </span>
            ) : null}
            <span className="settings-spacer" />
            {!isDefault ? <Button size="sm" variant="ghost" disabled={!provider.enabled || isRunning || Boolean(invalid)} title={!provider.enabled ? t.providers.enableFirst : undefined} onClick={onSetDefault}>{t.providers.setDefault}</Button> : null}
          </div>
          <p className="settings-note settings-provider-help">{!provider.enabled ? t.providers.disabledHint : isDefault ? t.providers.defaultHint : t.providers.probeHint}</p>
        </div>
      ) : null}
    </div>
  );
}
