import * as RadixDialog from "@radix-ui/react-dialog";
import { Brain, CalendarClock, Check, ChevronDown, CircleAlert, Copy, Info, KeyRound, MessagesSquare, Palette, Plug, Plus, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useCopy, useLocale } from "../../i18n/LocaleContext";
import { APP_LOCALES, type AppLocale } from "../../i18n/locales";
import { settingsCopy, type SettingsCopy } from "../../i18n/copy/settings";
import { vaultCopy } from "../../i18n/copy/vault";
import { appVersionLabel } from "../../appVersion";
import { AGENT_PRESETS, type AgentHarnessId } from "../../pi/harnessCatalog";
import { clearApprovalMemory, type PiRuntimeState } from "../../pi/piClient";
import {
  defaultProviderConnection,
  type AgentFrontendProject,
  type ProviderConnection,
  type ProviderConnectionId,
} from "../../schema/agentuxConfig";
import { themeTokens, type ThemePresetId } from "../../theme/themeTokens";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { useClipboardFeedback } from "../../runtime/useClipboardFeedback";
import type { ProviderSettingsStatus } from "../../runtime/useProviderSettings";
import { providerIsAdded, providerValidationIssue, type ProviderPatch } from "../../runtime/providerSettings";
import { useProviderProbe } from "../../runtime/useProviderProbe";
import { useProviderEditor } from "../../runtime/useProviderEditor";
import { ModelOptionsEditor } from "./ModelOptionsEditor";
import type { ImChannelsState } from "../../runtime/useImChannels";
import type { RoutinesState } from "../../runtime/useRoutines";
import type { RoutineView } from "../../pi/routineTypes";
import type { McpServersState } from "../../runtime/useMcpServers";
import type { McpServerView } from "../../pi/mcpTypes";
import type { MemoriesState } from "../../runtime/useMemories";
import type { SkillsState } from "../../runtime/useSkills";
import { SkillsSection } from "./SkillsSection";
import { UsageSection } from "./UsageSection";
import type { UsageViewState } from "../../runtime/useUsage";
import type { VaultSettingsState } from "../../runtime/useVault";
import type { VaultLoginInput, VaultLoginView } from "../../pi/vaultTypes";
import { MEMORY_COUNT_LIMIT, MEMORY_TEXT_LIMIT, type MemoryScope, type MemoryView } from "../../pi/memoryTypes";
import { CHANNEL_FIELDS, type ChannelPatch, type ChannelPlatform, type ChannelView } from "../../pi/imChannels/types";
import { useBotNames } from "../shell/ShellExtras";
import "./settings.css";

/**
 * Settings, as one dialog with a section rail. Layout and row patterns follow magpie
 * (name + muted sub-line + control on the right, masked key pill, inline test result) and
 * CC Switch (provider presets that only need a key, CLI status cards, latency colours).
 * Model service edits stay in a dialog draft until Save. Secrets remain session-only until
 * the host credential store is implemented; the UI states that boundary explicitly.
 */

export type PermissionMode = "request" | "auto" | "allow-all";
export type { ProviderPatch } from "../../runtime/providerSettings";

export type SettingsSectionId = "providers" | "permissions" | "channels" | "routines" | "mcp" | "memory" | "vault" | "usage" | "appearance" | "about";
type SectionId = SettingsSectionId;

const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI", dsh: "DeepSeek Harness" };
const INSTALL_COMMANDS: Partial<Record<AgentHarnessId, string>> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  dsh: "npm install -g @deepseek-ai/dsh@0.2.1-rc.2",
};
/** Stands for a key that is set but never sent to the page; it carries none of its characters. */
const MASK = "••••••••••••••••";
const LOCALE_LABELS: Record<AppLocale, string> = { zh: "中文", en: "English", ja: "日本語" };
const CHANNEL_LOGOS: Record<ChannelPlatform, string> = {
  feishu: "/brand/im/feishu.png",
  dingtalk: "/brand/im/dingtalk.png",
  wecom: "/brand/im/wecom.png",
  telegram: "/brand/im/telegram.svg",
};

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Section shown when the dialog opens. */
  initialSection?: SettingsSectionId;
  project: AgentFrontendProject;
  providerSettingsStatus?: ProviderSettingsStatus;
  runtime?: PiRuntimeState;
  isRunning: boolean;
  savedProviderSettings?: import("../../pi/piClient").ProviderSettingsView;
  sessionKeys: Record<string, string>;
  onSessionKeyChange: (id: ProviderConnectionId, value: string) => void;
  onUpdateProvider: (id: ProviderConnectionId, patch: ProviderPatch) => void;
  onSetDefaultProvider: (id: ProviderConnectionId) => void;
  /** Persist configuration and explicit credential changes on the host before applying. */
  onSaveProviders?: (providers: AgentFrontendProject["providers"], keys: Record<string, string>, removeKeys: string[]) => void | Promise<void>;
  permissionDefault?: PermissionMode;
  onPermissionDefaultChange: (mode: PermissionMode | undefined) => void;
  themePreset: ThemePresetId;
  onThemeChange: (id: ThemePresetId) => void;
  /** IM channels from the host; the section is hidden when absent (fixtures, static previews). */
  imChannels?: ImChannelsState;
  /** Routines from the host (ADR-033); the section is hidden when absent (fixtures, static previews). */
  routines?: RoutinesState;
  /** MCP servers from the host (ADR-037); the section is hidden when absent (fixtures, static previews). */
  mcpServers?: McpServersState;
  /** Text Skills share the existing MCP settings surface. */
  skills?: SkillsState;
  usage?: UsageViewState;
  /** Cross-conversation memory from the host (ADR-038); the section is hidden when absent (fixtures, static previews). */
  memories?: MemoriesState;
  memoryScopes?: { scope: MemoryScope; label: string }[];
  /** Public login metadata; absent in fixtures and static previews. */
  vault?: VaultSettingsState;
  /** Opens a routine's conversation and closes the dialog. */
  onOpenConversation?: (conversationId: string) => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  const { locale } = useLocale();
  const t = settingsCopy[locale];
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "providers");
  const [confirmClose, setConfirmClose] = useState(false);
  const editor = useProviderEditor(props.project.providers, props.sessionKeys, async (providers, keys, removeKeys) => {
    if (props.onSaveProviders) return props.onSaveProviders(providers, keys, removeKeys);
    // Optional callback keeps standalone fixtures and older hosts compatible.
    for (const provider of providers.connections) {
      const original = props.project.providers.connections.find(item => item.id === provider.id);
      if (JSON.stringify(provider) !== JSON.stringify(original)) props.onUpdateProvider(provider.id, {
        baseUrl: provider.baseUrl, defaultModel: provider.defaultModel, models: provider.models, modelOptions: provider.modelOptions,
        enabled: provider.enabled, added: provider.added, authEnvVar: provider.auth.envVar,
      });
      if (keys[provider.id] !== props.sessionKeys[provider.id]) props.onSessionKeyChange(provider.id, keys[provider.id] ?? "");
    }
    if (providers.defaultProviderId !== props.project.providers.defaultProviderId) props.onSetDefaultProvider(providers.defaultProviderId);
  });
  const saving = editor.status === "saving";
  const requestOpenChange = (open: boolean) => {
    if (!open && saving) return;
    if (!open && editor.dirty) { setSection("providers"); setConfirmClose(true); return; }
    props.onOpenChange(open);
  };
  useEffect(() => {
    if (props.open) { setSection(props.initialSection ?? "providers"); setConfirmClose(false); }
  }, [props.open, props.initialSection]);
  const nav: { id: SectionId; label: string; Icon: typeof Server }[] = [
    { id: "providers", label: t.nav.providers, Icon: Server },
    { id: "permissions", label: t.nav.permissions, Icon: ShieldCheck },
    ...(props.imChannels ? [{ id: "channels" as const, label: t.nav.channels, Icon: MessagesSquare }] : []),
    ...(props.routines ? [{ id: "routines" as const, label: t.nav.routines, Icon: CalendarClock }] : []),
    ...(props.mcpServers || props.skills ? [{ id: "mcp" as const, label: props.skills ? (locale === "zh" ? "MCP 与 Skills" : "MCP & Skills") : t.nav.mcp, Icon: Plug }] : []),
    ...(props.memories ? [{ id: "memory" as const, label: t.nav.memory, Icon: Brain }] : []),
    ...(props.usage ? [{ id: "usage" as const, label: locale === "zh" ? "模型用量" : "Model usage", Icon: Info }] : []),
    ...(props.vault ? [{ id: "vault" as const, label: vaultCopy[locale].nav, Icon: KeyRound }] : []),
    { id: "appearance", label: t.nav.appearance, Icon: Palette },
    { id: "about", label: t.nav.about, Icon: Info },
  ];

  return (
    <RadixDialog.Root open={props.open} onOpenChange={requestOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="settings-overlay" />
        <RadixDialog.Content className="settings-dialog" aria-describedby={undefined} onCloseAutoFocus={props.onCloseAutoFocus}>
          <nav className="settings-rail" aria-label={t.title}>
            <RadixDialog.Title className="settings-rail-title">{t.title}</RadixDialog.Title>
            {nav.map(({ id, label, Icon }) => (
              <button
                type="button"
                key={id}
                className="settings-rail-item"
                data-group-start={id === "channels" || id === "appearance" || undefined}
                aria-current={section === id ? "page" : undefined}
                onClick={() => setSection(id)}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
            <span className="settings-rail-version">{appVersionLabel}</span>
          </nav>
          <section className="settings-body" aria-label={nav.find((item) => item.id === section)?.label}>
            <header className="settings-body-header">
              <h2>{nav.find((item) => item.id === section)?.label}</h2>
              <RadixDialog.Close className="settings-close" aria-label={t.close}>
                <X size={16} aria-hidden="true" />
              </RadixDialog.Close>
            </header>
            <div className="settings-body-scroll">
              {section === "providers" ? <fieldset className="settings-provider-fields" disabled={saving} aria-label={t.nav.providers}>
                <ProvidersSection {...props} t={t} project={{ ...props.project, providers: editor.providers }} sessionKeys={editor.keys}
                  probeRevision={editor.revision} removeKeys={editor.removeKeys} onToggleRemoveKey={editor.toggleRemoveKey}
                  onUpdateProvider={editor.update} onSessionKeyChange={editor.setKey} onSetDefaultProvider={editor.setDefault} />
              </fieldset> : null}
              {section === "permissions" ? <PermissionsSection {...props} t={t} /> : null}
              {section === "channels" && props.imChannels ? <ChannelsSection t={t} state={props.imChannels} /> : null}
              {section === "routines" && props.routines ? <RoutinesSection t={t} state={props.routines} onOpenConversation={props.onOpenConversation} /> : null}
              {section === "mcp" && props.mcpServers ? <McpSection t={t} state={props.mcpServers} /> : null}
              {section === "mcp" && props.skills ? <SkillsSection state={props.skills} /> : null}
              {section === "memory" && props.memories ? <MemorySection t={t} state={props.memories} scopes={props.memoryScopes} /> : null}
              {section === "usage" && props.usage ? <UsageSection usage={props.usage} /> : null}
              {props.open && section === "vault" && props.vault ? <VaultSection state={props.vault} /> : null}
              {section === "appearance" ? <AppearanceSection {...props} t={t} /> : null}
              {section === "about" ? <AboutSection {...props} t={t} /> : null}
            </div>
            {section === "providers" ? <footer className="settings-save-footer">
              <p className="settings-note">{t.providers.saveScope}</p>
              <div className="settings-save-actions">
                <span className="settings-status" role="status" data-tone={editor.invalid || editor.status === "failed" || editor.status === "conflict" ? "error" : editor.status === "saved" ? "ok" : "muted"}>
                  {editor.invalid ? `${editor.invalid.provider.label}：${editor.invalid.field === "modelOptions" ? (locale === "zh" ? "请检查模型参数，输出上限不能超过上下文窗口。" : "Check model options. Output cannot exceed the context window.") : t.providers.validation[editor.invalid.field!]}`
                    : editor.status === "failed" ? t.providers.saveFailed : editor.status === "conflict" ? t.providers.saveConflict
                    : saving ? t.providers.saving : confirmClose ? t.providers.unsavedClose : props.isRunning ? t.providers.runningHint
                    : editor.dirty ? t.providers.unsaved : editor.status === "saved" ? t.providers.saved : ""}
                </span>
                <span className="settings-spacer" />
                {confirmClose ? <Button size="sm" variant="ghost" autoFocus disabled={saving} onClick={() => setConfirmClose(false)}>{t.providers.keepEditing}</Button> : null}
                <Button size="sm" variant="ghost" disabled={!editor.dirty || saving} onClick={() => {
                  editor.reset(); if (confirmClose) { setConfirmClose(false); props.onOpenChange(false); }
                }}>{confirmClose ? t.providers.discardClose : t.providers.discard}</Button>
                <Button size="sm" variant="primary" disabled={!editor.dirty || Boolean(editor.invalid) || props.isRunning} loading={saving} onClick={async () => {
                  if (await editor.save() && confirmClose) { setConfirmClose(false); props.onOpenChange(false); }
                }}>{confirmClose ? t.providers.saveClose : t.providers.save}</Button>
              </div>
            </footer> : null}
          </section>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type SectionProps = SettingsDialogProps & { t: SettingsCopy; probeRevision?: number };

function ProvidersSection({
  t, project, runtime, sessionKeys, onSessionKeyChange, onUpdateProvider, onSetDefaultProvider, isRunning, providerSettingsStatus = "idle", probeRevision, savedProviderSettings, removeKeys = [], onToggleRemoveKey,
}: SectionProps & { removeKeys?: string[]; onToggleRemoveKey?: (id: string) => void }) {
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

function PermissionsSection({ t, runtime, permissionDefault, onPermissionDefaultChange }: SectionProps) {
  const frame = useCopy().composer.frame;
  const label = (mode: PermissionMode) =>
    mode === "request" ? frame.toolPermissionRequest : mode === "auto" ? frame.toolPermissionAuto : frame.toolPermissionAllowAll;
  const hint = (mode: PermissionMode) =>
    mode === "request" ? frame.toolPermissionRequestHint : mode === "auto" ? frame.toolPermissionAutoHint : frame.toolPermissionAllowAllHint;
  const hostMode = runtime?.defaultPermissionMode ?? "request";
  const current = permissionDefault ?? "host";
  return (
    <>
      <p className="settings-intro">{t.permissions.intro}</p>
      <div className="settings-list">
        {(["host", "request", "auto", "allow-all"] as const).map((mode) => (
          <label className="settings-row settings-radio-row" key={mode} data-selected={current === mode}>
            <input
              type="radio"
              name="permission-default"
              checked={current === mode}
              onChange={() => onPermissionDefaultChange(mode === "host" ? undefined : mode)}
            />
            <span className="settings-row-main">
              <span className="settings-row-title"><strong>{mode === "host" ? t.permissions.hostDefault(label(hostMode)) : label(mode)}</strong></span>
              <span className="settings-row-sub">{mode === "host" ? t.permissions.hostHint : hint(mode)}</span>
              {mode === "allow-all" ? <span className="settings-status" data-tone="error"><Dot />{t.permissions.allowAllWarning}</span> : null}
            </span>
          </label>
        ))}
      </div>
      <h3 className="settings-subhead">{t.permissions.alwaysTitle}</h3>
      <p className="settings-intro">{t.permissions.alwaysHint}</p>
      <AlwaysAllowedList t={t} runtime={runtime} />
      <h3 className="settings-subhead">{t.permissions.secretTitle}</h3>
      <p className="settings-intro">{t.permissions.secretHint}</p>
      <div className="settings-list settings-code-list">
        {(runtime?.secretPaths ?? []).map((path) => <code key={path}>{path}</code>)}
      </div>
      <h3 className="settings-subhead">{t.permissions.protectedTitle}</h3>
      <p className="settings-intro">{t.permissions.protectedHint}</p>
      <div className="settings-list settings-code-list">
        {(runtime?.protectedPaths ?? []).map((path) => <code key={path}>{path}</code>)}
      </div>
      {runtime?.readOnlyPaths?.length ? (
        <>
          <h3 className="settings-subhead">{t.permissions.readOnlyTitle}</h3>
          <p className="settings-intro">{t.permissions.readOnlyHint}</p>
          <div className="settings-list settings-code-list">
            {runtime.readOnlyPaths.map((path) => <code key={path}>{path}</code>)}
          </div>
        </>
      ) : null}
      <h3 className="settings-subhead">{t.permissions.workspace}</h3>
      <WorkspaceList t={t} runtime={runtime} />
    </>
  );
}

/** Tools each agent may run without asking, granted by "always allow"; each agent can be reset. */
function AlwaysAllowedList({ t, runtime }: { t: SettingsCopy; runtime?: PiRuntimeState }) {
  const botNames = useBotNames();
  const [granted, setGranted] = useState<Record<string, string[]>>(runtime?.alwaysAllowed ?? {});
  useEffect(() => setGranted(runtime?.alwaysAllowed ?? {}), [runtime?.alwaysAllowed]);
  const agents = AGENT_PRESETS.filter((preset) => granted[preset.id]?.length);
  if (agents.length === 0) return <p className="settings-intro">{t.permissions.alwaysEmpty}</p>;
  return (
    <div className="settings-list">
      {agents.map((preset) => (
        <div className="settings-row" key={preset.id}>
          <span className="settings-row-main">
            <span className="settings-row-title"><strong>{botNames[preset.id]}</strong></span>
            <span className="settings-row-sub">{granted[preset.id].join(", ")}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => void clearApprovalMemory(preset.id).then(setGranted).catch(() => undefined)}>
            {t.permissions.alwaysClear}
          </Button>
        </div>
      ))}
    </div>
  );
}

function WorkspaceList({ t, runtime }: { t: SettingsCopy; runtime?: PiRuntimeState }) {
  const botNames = useBotNames();
  const agents = runtime?.workspace?.agents ?? {};
  const rows: [string, string, string][] = [
    ...AGENT_PRESETS.map((preset): [string, string, string] => [preset.id, botNames[preset.id], agents[preset.id] ?? runtime?.cwd ?? "—"]),
    ...(runtime?.workspace?.shared ? [["shared", t.permissions.shared, runtime.workspace.shared] as [string, string, string]] : []),
  ];
  return (
    <div className="settings-list">
      {rows.map(([id, label, path]) => (
        <div className="settings-row settings-about-row" key={id}>
          <span className="settings-about-label">{label}</span>
          <code>{path}</code>
          {path !== "—" ? <CopyButton t={t.about} value={path} /> : null}
        </div>
      ))}
    </div>
  );
}

function ChannelsSection({ t, state }: { t: SettingsCopy; state: ImChannelsState }) {
  const [expanded, setExpanded] = useState<string | undefined>();
  return (
    <>
      <p className="settings-intro">{t.channels.intro}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{t.channels.loadFailed(state.error)}</p> : null}
      <div className="settings-list">
        {(state.channels ?? []).map((channel) => (
          <ChannelRow
            key={channel.platform}
            t={t}
            channel={channel}
            state={state}
            open={expanded === channel.platform}
            onToggleOpen={() => setExpanded((current) => (current === channel.platform ? undefined : channel.platform))}
          />
        ))}
      </div>
      <p className="settings-note">{t.channels.commands}</p>
    </>
  );
}

function ChannelRow({ t, channel, state, open, onToggleOpen }: {
  t: SettingsCopy;
  channel: ChannelView;
  state: ImChannelsState;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const c = t.channels;
  const botNames = useBotNames();
  const name = c.names[channel.platform];
  const [fields, setFields] = useState<Record<string, string>>(channel.fields);
  const [allowText, setAllowText] = useState(channel.allowUsers.join(", "));
  useEffect(() => setAllowText(channel.allowUsers.join(", ")), [channel.allowUsers]);
  const saving = state.saving === channel.platform;
  const saveError = state.saveError?.platform === channel.platform ? state.saveError.message : undefined;
  const complete = CHANNEL_FIELDS[channel.platform].every(({ key, secret }) => fields[key]?.trim() || (secret && channel.secretsSet[key]));
  const tone = { off: "muted", connecting: "warn", connected: "ok", error: "error" }[channel.status.state];
  const allowUsers = (text: string) => text.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean);
  const save = (patch: ChannelPatch) => void state.save(channel.platform, patch);
  const saveAll = () => {
    save({ enabled: true, fields, allowUsers: allowUsers(allowText) });
    setFields((current) => Object.fromEntries(Object.entries(current).map(([key, value]) =>
      [key, CHANNEL_FIELDS[channel.platform].find((field) => field.key === key)?.secret ? "" : value])));
  };

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row">
        <span className="settings-channel-mark" aria-hidden="true">
          <img src={CHANNEL_LOGOS[channel.platform]} alt="" width={28} height={28} />
        </span>
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{name}</strong></span>
          <span className="settings-row-sub settings-row-meta">
            {channel.status.botName ? <span>{channel.status.botName}</span> : null}
            <span>{botNames[channel.botId ?? channel.agentPreset] ?? channel.botId}</span>
            <span>{channel.access === "open" ? c.open : c.allowlist}</span>
          </span>
        </button>
        <span className="settings-key-pill" data-tone={tone}><Dot />{c.state[channel.status.state]}</span>
        <Switch
          size="sm"
          aria-label={`${t.providers.enabled} ${name}`}
          checked={channel.enabled}
          disabled={saving || (!channel.enabled && !complete)}
          title={!channel.enabled && !complete ? c.fillFirst : undefined}
          // Turning on also sends what is typed, so a filled-in form connects without a second click.
          onCheckedChange={(checked) => (checked ? saveAll() : save({ enabled: false }))}
        />
        <button type="button" className="settings-chevron" aria-label={name} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <p className="settings-note">{c.setup[channel.platform]}</p>
          {CHANNEL_FIELDS[channel.platform].map(({ key, secret }) => (
            <Field key={key} label={c.fields[key as keyof typeof c.fields]} hint={secret && channel.secretsSet[key] ? c.secretHint : undefined}>
              <div className="settings-field-row">
                <Input
                  type={secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secret ? (channel.secretsSet[key] ? MASK : c.secretEmpty) : undefined}
                  value={fields[key] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFields((current) => ({ ...current, [key]: value }));
                  }}
                />
                {secret && channel.secretsSet[key] && !fields[key] ? <span className="settings-status" data-tone="ok"><Dot />{c.secretSaved}</span> : null}
              </div>
            </Field>
          ))}
          <Field label={c.role}>
            <SelectMenu
              ariaLabel={c.role}
              value={channel.botId ?? channel.agentPreset}
              options={Object.entries(botNames).map(([value, label]) => ({ value, label }))}
              onValueChange={(value) => save({ botId: value })}
            />
          </Field>
          <Field label={c.access}>
            <Segmented
              ariaLabel={c.access}
              value={channel.access}
              options={[{ value: "allowlist" as const, label: c.allowlist }, { value: "open" as const, label: c.open }]}
              disabled={saving}
              onChange={(access) => save({ access })}
            />
          </Field>
          {channel.access === "open" ? <span className="settings-status" data-tone="error"><Dot />{c.openWarning}</span> : (
            <Field label={c.allowUsers} hint={c.allowUsersHint}>
              <Input
                spellCheck={false}
                value={allowText}
                onChange={(event) => setAllowText(event.target.value)}
                onBlur={() => {
                  const next = allowUsers(allowText);
                  if (next.join() !== channel.allowUsers.join()) save({ allowUsers: next });
                }}
              />
            </Field>
          )}
          {channel.denied.length > 0 && channel.access === "allowlist" ? (
            <Field label={c.denied}>
              <div className="settings-list">
                {channel.denied.map((entry) => (
                  <div className="settings-row settings-about-row" key={entry.id}>
                    <span className="settings-about-label">{entry.name ?? "—"}</span>
                    <code>{entry.id}</code>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => save({ allowUsers: [...channel.allowUsers, entry.id] })}>{c.allow}</Button>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}
          <p className="settings-note">{channel.model ? c.model(channel.model.model) : c.noModel}</p>
          <div className="settings-provider-actions">
            <Button size="sm" disabled={saving || !complete} onClick={saveAll}>
              {saving ? c.saving : channel.enabled && channel.status.state === "error" ? c.reconnect : c.save}
            </Button>
            {saveError ? (
              <span className="settings-status" data-tone="error" role="status"><Dot />{c.saveFailed(saveError)}</span>
            ) : channel.status.error ? (
              <span className="settings-status" data-tone="error" role="status"><Dot />{channel.status.error}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AppearanceSection({ t, themePreset, onThemeChange }: SectionProps) {
  const { locale, setLocale } = useLocale();
  return (
    <>
      <div className="settings-list">
        <div className="settings-row">
          <span className="settings-row-main"><strong>{t.appearance.language}</strong></span>
          <Segmented
            ariaLabel={t.appearance.language}
            value={locale}
            options={APP_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }))}
            onChange={setLocale}
          />
        </div>
      </div>
      <h3 className="settings-subhead">{t.appearance.theme}</h3>
      <div className="settings-themes" role="radiogroup" aria-label={t.appearance.theme}>
        {Object.values(themeTokens).map((theme) => (
          <button
            type="button"
            role="radio"
            aria-checked={theme.id === themePreset}
            key={theme.id}
            className="settings-theme"
            onClick={() => onThemeChange(theme.id)}
          >
            <span className="settings-theme-swatch" aria-hidden="true" style={{ background: theme.surface.canvas, borderColor: theme.border.strong }}>
              <span style={{ background: theme.surface.panel }} />
              <span style={{ background: theme.accent.action }} />
            </span>
            <span className="settings-theme-name">{t.appearance[theme.appearance]}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function AboutSection({ t, runtime }: SectionProps) {
  const harness = (id: AgentHarnessId) => runtime?.harnesses?.find((entry) => entry.id === id);
  const rows: [string, string][] = [
    [t.about.version, appVersionLabel],
    [t.about.runtime, runtime?.sandboxed ? t.about.sandbox : t.about.local],
    [t.about.workspace, runtime?.workspace?.root ?? runtime?.cwd ?? "—"],
    [t.about.session, runtime?.sessionId ?? "—"],
    ["Claude Code", harness("claude-code")?.version ?? "—"],
    ["Codex CLI", harness("codex")?.version ?? "—"],
    [t.about.docs, "docs/product/README.md"],
  ];
  return (
    <div className="settings-list">
      {rows.map(([label, value]) => (
        <div className="settings-row settings-about-row" key={label}>
          <span className="settings-about-label">{label}</span>
          <code>{value}</code>
          {value !== "—" ? <CopyButton t={t.about} value={value} /> : null}
        </div>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <span className="settings-field-control">
        {children}
        {hint ? <small className="settings-note">{hint}</small> : null}
      </span>
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel, disabled }: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={option.value}
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CopyButton({ t, value }: { t: { copy: string; copied: string }; value: string }) {
  const clipboard = useClipboardFeedback(value);
  const failure = useCopy().chat.message.actions.copyFailedText;
  const label = clipboard.status === "copied" ? t.copied : clipboard.status === "failed" ? failure : t.copy;
  return (
    <button
      type="button"
      className="settings-copy"
      aria-label={label}
      title={label}
      onClick={(event) => void clipboard.copy(event.currentTarget.closest(".settings-about-row")?.querySelector("code"))}
    >
      {clipboard.status === "copied" ? <Check size={13} aria-hidden="true" /> : clipboard.status === "failed" ? <CircleAlert size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

function RoutinesSection({ t, state, onOpenConversation }: { t: SettingsCopy; state: RoutinesState; onOpenConversation?: (id: string) => void }) {
  const botNames = useBotNames();
  const [expanded, setExpanded] = useState<string | undefined>();
  return (
    <>
      <p className="settings-intro">{t.routines.intro.replaceAll("{assistant}", botNames.assistant)}</p>
      <p className="settings-note">{t.routines.clockNote}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{t.routines.loadFailed(state.error)}</p> : null}
      {state.routines?.length === 0 ? <p className="settings-note">{t.routines.empty}</p> : null}
      <div className="settings-list">
        {(state.routines ?? []).map((routine) => (
          <RoutineRow
            key={routine.id}
            t={t}
            routine={routine}
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

function RoutineRow({ t, routine, state, open, onToggleOpen, onOpenConversation }: {
  t: SettingsCopy;
  routine: RoutineView;
  state: RoutinesState;
  open: boolean;
  onToggleOpen: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const c = t.routines;
  const botNames = useBotNames();
  const { locale } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const busy = state.busy === routine.id;
  const failure = state.actionError?.id === routine.id ? state.actionError.message : undefined;
  const last = routine.lastRun;
  const tone = !last ? "muted" : { running: "warn", success: "ok", error: "error", cancelled: "muted", interrupted: "warn" }[last.status];
  const when = last ? new Date(last.at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : undefined;

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row">
        <ProviderMark label={routine.title} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{routine.title}</strong></span>
          <span className="settings-row-sub settings-row-meta">
            <span>{botNames[routine.botId ?? "assistant"] ?? routine.botId}</span>
            <code>{routine.schedule}</code><span>{routine.timezone}</span>{when ? <span>{when}</span> : null}
          </span>
        </button>
        <span className="settings-key-pill" data-tone={last?.waiting ? "warn" : tone}><Dot />{last?.waiting ? c.waiting : last ? c.status[last.status] : c.neverRun}</span>
        <Switch
          size="sm"
          aria-label={`${routine.title} ${c.enable}`}
          checked={routine.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void state.setEnabled(routine.id, checked)}
        />
        <button type="button" className="settings-chevron" aria-label={routine.title} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <p className="settings-note">{routine.instructions}</p>
          {routine.disabledReason && !routine.enabled ? <span className="settings-status" data-tone="error"><Dot />{c.switchedOff(routine.disabledReason)}</span> : null}
          {last?.status === "error" && last.error && routine.enabled ? <span className="settings-status" data-tone="error"><Dot />{last.error}</span> : null}
          {last?.waiting ? <span className="settings-status" data-tone="warn" role="status"><Dot />{c.waitingNote}</span> : null}
          <div className="settings-provider-actions">
            <Button size="sm" disabled={busy || !routine.enabled || last?.status === "running"} title={routine.enabled ? undefined : c.turnOnFirst}
              onClick={() => void state.runNow(routine.id)}>{c.runNow}</Button>
            {onOpenConversation ? (
              <Button size="sm" variant="ghost" disabled={!last} onClick={() => onOpenConversation(routine.conversationId)}>{c.openConversation}</Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy} onBlur={() => setConfirming(false)}
              onClick={() => { if (confirming) void state.remove(routine.id); else setConfirming(true); }}>
              {confirming ? c.confirmRemove : c.remove}
            </Button>
            {failure ? <span className="settings-status" data-tone="error" role="status"><Dot />{failure}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function McpSection({ t, state }: { t: SettingsCopy; state: McpServersState }) {
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

/** One saved server, or the form for a new one when `server` is absent. */
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
  const busy = state.busy === key;
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
            <Button size="sm" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>{busy ? c.saving : c.save}</Button>
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

const memoryScopeKey = (scope?: MemoryScope) => !scope || scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
type MemoryScopeOption = { scope: MemoryScope; label: string; available: boolean };

function MemorySection({ t, state, scopes = [] }: { t: SettingsCopy; state: MemoriesState; scopes?: SettingsDialogProps["memoryScopes"] }) {
  const c = t.memory;
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("all");
  const [addScope, setAddScope] = useState("global");
  const memory = state.memory;
  const options = new Map<string, MemoryScopeOption>([["global", { scope: { kind: "global" }, label: zh ? "全局" : "Global", available: true }]]);
  for (const option of scopes) options.set(memoryScopeKey(option.scope), { ...option, available: true });
  for (const item of memory?.memories ?? []) {
    const scope = item.scope ?? { kind: "global" as const };
    if (!options.has(memoryScopeKey(scope))) options.set(memoryScopeKey(scope), { scope, label: scope.kind === "global" ? (zh ? "全局" : "Global")
      : `${scope.kind === "bot" ? "Bot" : zh ? "群聊" : "Group"} · ${scope.id} (${zh ? "已不可用" : "unavailable"})`, available: false });
  }
  const scopeOptions = [...options.values()];
  const available = scopeOptions.filter(option => option.available);
  const memories = [...(memory?.memories ?? [])].reverse().filter(item => filter === "all" || memoryScopeKey(item.scope) === filter);
  const addFailure = state.actionError?.id === "new" ? state.actionError.message : undefined;
  const selectedAddScope = available.find(option => memoryScopeKey(option.scope) === addScope)?.scope;
  const add = async () => { if (!state.busy && draft.trim() && selectedAddScope && await state.save(undefined, draft, selectedAddScope)) setDraft(""); };
  return (
    <>
      <p className="settings-intro">{zh ? "记忆可供所有 Bot、指定 Bot 或指定群聊使用。聊天中保存时默认归当前 Bot 或群聊，全局记忆供所有对话使用。" : "Memories can be shared globally, with one Bot, or within one group. Chat saves default to the current Bot or group; global memories are available in every conversation."}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{c.loadFailed(state.error)}</p> : null}
      {memory ? (
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row-main"><span className="settings-row-title"><strong>{c.enable}</strong></span>
              <span className="settings-row-sub">{c.count(memory.memories.length, MEMORY_COUNT_LIMIT)}</span></span>
            <Switch size="sm" aria-label={c.enable} checked={memory.enabled} disabled={state.busy === "settings"}
              onCheckedChange={(checked) => void state.setEnabled(checked)} />
          </div>
        </div>
      ) : null}
      {memory ? <div className="settings-memory-controls">
        <SelectMenu ariaLabel={zh ? "按范围筛选记忆" : "Filter memories by scope"} value={filter} onValueChange={setFilter}
          options={[{ value: "all", label: zh ? "全部范围" : "All scopes" }, ...scopeOptions.map(option => ({ value: memoryScopeKey(option.scope), label: option.label }))]} />
      </div> : null}
      {memory && !memory.enabled ? <p className="settings-status" data-tone="warn" role="note"><Dot />{c.off}</p> : null}
      {memory && memories.length === 0 ? <p className="settings-note">{filter === "all" ? c.empty : zh ? "这个范围还没有记忆。" : "No memories in this scope."}</p> : null}
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
          <SelectMenu ariaLabel={zh ? "新记忆的范围" : "New memory scope"} value={addScope} onValueChange={setAddScope} disabled={Boolean(state.busy)}
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
        {editing ? <SelectMenu ariaLabel={locale === "zh" ? "记忆范围" : "Memory scope"} value={scopeKey} disabled={busy}
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

function VaultSection({ state }: { state: VaultSettingsState }) {
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

/** The only place credential drafts are held; unmounted on cancel, success or settings close. */
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

function ProviderMark({ label }: { label: string }) {
  return <span className="settings-mark" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>;
}

function Dot() {
  return <span className="settings-dot" aria-hidden="true" />;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
