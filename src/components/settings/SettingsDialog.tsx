import * as RadixDialog from "@radix-ui/react-dialog";
import { Brain, CalendarClock, Check, ChevronDown, CircleAlert, Copy, Info, MessagesSquare, Palette, Plug, Plus, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useCopy, useLocale } from "../../i18n/LocaleContext";
import { APP_LOCALES, type AppLocale } from "../../i18n/locales";
import { settingsCopy, type SettingsCopy } from "../../i18n/copy/settings";
import { appVersionLabel } from "../../appVersion";
import { AGENT_PRESETS, type AgentHarnessId } from "../../pi/harnessCatalog";
import { clearApprovalMemory, testProviderConnection, type PiRuntimeState, type ProviderTestResult } from "../../pi/piClient";
import { piRuntimeConfigurationForProvider } from "../../pi/piProviderSync";
import {
  defaultProviderConnection,
  isSafeProviderEnvVarName,
  safeProviderEnvVarName,
  type AgentFrontendProject,
  type ProviderConnection,
  type ProviderConnectionId,
} from "../../schema/agentuxConfig";
import { themeTokens, type ThemePresetId } from "../../theme/themeTokens";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { useClipboardFeedback } from "../../runtime/useClipboardFeedback";
import type { ProviderSettingsStatus } from "../../runtime/useProviderSettings";
import type { ProviderPatch } from "../../runtime/providerSettings";
import type { ImChannelsState } from "../../runtime/useImChannels";
import type { RoutinesState } from "../../runtime/useRoutines";
import type { RoutineView } from "../../pi/routineTypes";
import type { McpServersState } from "../../runtime/useMcpServers";
import type { McpServerView } from "../../pi/mcpTypes";
import type { MemoriesState } from "../../runtime/useMemories";
import { MEMORY_COUNT_LIMIT, MEMORY_TEXT_LIMIT, type MemoryView } from "../../pi/memoryTypes";
import { CHANNEL_FIELDS, type ChannelPatch, type ChannelView } from "../../pi/imChannels/types";
import "./settings.css";

/**
 * Settings, as one dialog with a section rail. Layout and row patterns follow magpie
 * (name + muted sub-line + control on the right, masked key pill, inline test result) and
 * CC Switch (provider presets that only need a key, CLI status cards, latency colours).
 * Every change applies at once; there is no Save button, except for IM channel credentials,
 * which connect to an outside service and are sent together once complete.
 */

export type PermissionMode = "request" | "auto" | "allow-all";
export type { ProviderPatch } from "../../runtime/providerSettings";

export type SettingsSectionId = "providers" | "permissions" | "channels" | "routines" | "mcp" | "memory" | "appearance" | "about";
type SectionId = SettingsSectionId;

const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI" };
const INSTALL_COMMANDS: Partial<Record<AgentHarnessId, string>> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};
/** Stands for a key that is set but never sent to the page; it carries none of its characters. */
const MASK = "••••••••••••••••";
const LOCALE_LABELS: Record<AppLocale, string> = { zh: "中文", en: "English", ja: "日本語" };

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section shown when the dialog opens. */
  initialSection?: SettingsSectionId;
  project: AgentFrontendProject;
  providerSettingsStatus?: ProviderSettingsStatus;
  runtime?: PiRuntimeState;
  isRunning: boolean;
  sessionKeys: Record<string, string>;
  onSessionKeyChange: (id: ProviderConnectionId, value: string) => void;
  onUpdateProvider: (id: ProviderConnectionId, patch: ProviderPatch) => void;
  onSetDefaultProvider: (id: ProviderConnectionId) => void;
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
  /** Cross-conversation memory from the host (ADR-038); the section is hidden when absent (fixtures, static previews). */
  memories?: MemoriesState;
  /** Opens a routine's conversation and closes the dialog. */
  onOpenConversation?: (conversationId: string) => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  const { locale } = useLocale();
  const t = settingsCopy[locale];
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "providers");
  useEffect(() => {
    if (props.open) setSection(props.initialSection ?? "providers");
  }, [props.open, props.initialSection]);
  const nav: { id: SectionId; label: string; Icon: typeof Server }[] = [
    { id: "providers", label: t.nav.providers, Icon: Server },
    { id: "permissions", label: t.nav.permissions, Icon: ShieldCheck },
    ...(props.imChannels ? [{ id: "channels" as const, label: t.nav.channels, Icon: MessagesSquare }] : []),
    ...(props.routines ? [{ id: "routines" as const, label: t.nav.routines, Icon: CalendarClock }] : []),
    ...(props.mcpServers ? [{ id: "mcp" as const, label: t.nav.mcp, Icon: Plug }] : []),
    ...(props.memories ? [{ id: "memory" as const, label: t.nav.memory, Icon: Brain }] : []),
    { id: "appearance", label: t.nav.appearance, Icon: Palette },
    { id: "about", label: t.nav.about, Icon: Info },
  ];

  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="settings-overlay" />
        <RadixDialog.Content className="settings-dialog" aria-describedby={undefined}>
          <nav className="settings-rail" aria-label={t.title}>
            <RadixDialog.Title className="settings-rail-title">{t.title}</RadixDialog.Title>
            {nav.map(({ id, label, Icon }) => (
              <button
                type="button"
                key={id}
                className="settings-rail-item"
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
              {section === "providers" ? <ProvidersSection {...props} t={t} /> : null}
              {section === "permissions" ? <PermissionsSection {...props} t={t} /> : null}
              {section === "channels" && props.imChannels ? <ChannelsSection t={t} state={props.imChannels} /> : null}
              {section === "routines" && props.routines ? <RoutinesSection t={t} state={props.routines} onOpenConversation={props.onOpenConversation} /> : null}
              {section === "mcp" && props.mcpServers ? <McpSection t={t} state={props.mcpServers} /> : null}
              {section === "memory" && props.memories ? <MemorySection t={t} state={props.memories} /> : null}
              {section === "appearance" ? <AppearanceSection {...props} t={t} /> : null}
              {section === "about" ? <AboutSection {...props} t={t} /> : null}
            </div>
          </section>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type SectionProps = SettingsDialogProps & { t: SettingsCopy };

function ProvidersSection({
  t, project, runtime, sessionKeys, onSessionKeyChange, onUpdateProvider, onSetDefaultProvider, isRunning, providerSettingsStatus = "idle",
}: SectionProps) {
  const [expanded, setExpanded] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const enabled = project.providers.connections.filter((provider) => provider.enabled);
  const available = project.providers.connections.filter((provider) => !provider.enabled);
  const defaultId = defaultProviderConnection(project).id;

  return (
    <>
      <p className="settings-intro">{t.providers.intro}</p>
      {providerSettingsStatus === "load-failed" || providerSettingsStatus === "save-failed" ? <p className="settings-status" data-tone="error" role="status">
        {t.providers.persistence[providerSettingsStatus]}
      </p> : null}
      <div className="settings-list">
        {enabled.map((provider) => (
          <ProviderRow
            key={provider.id}
            t={t}
            provider={provider}
            isDefault={provider.id === defaultId}
            onlyOne={enabled.length === 1}
            open={expanded === provider.id}
            onToggleOpen={() => setExpanded((current) => (current === provider.id ? undefined : provider.id))}
            sessionKey={sessionKeys[provider.id] ?? ""}
            runtime={runtime}
            isRunning={isRunning}
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
            {project.providers.connections.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className="settings-tile"
                disabled={provider.enabled}
                onClick={() => {
                  onUpdateProvider(provider.id, { enabled: true });
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
  t, provider, isDefault, onlyOne, open, onToggleOpen, sessionKey, runtime, isRunning, onSessionKeyChange, onUpdate, onSetDefault,
}: {
  t: SettingsCopy;
  provider: ProviderConnection;
  isDefault: boolean;
  onlyOne: boolean;
  open: boolean;
  onToggleOpen: () => void;
  sessionKey: string;
  runtime?: PiRuntimeState;
  isRunning: boolean;
  onSessionKeyChange: (value: string) => void;
  onUpdate: (patch: ProviderPatch) => void;
  onSetDefault: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | "running" | undefined>();
  const envVar = provider.auth.mode === "env" ? provider.auth.envVar : "";
  const envSet = Boolean(envVar && runtime?.envKeys?.includes(envVar));
  const keyState = provider.auth.mode === "none"
    ? { tone: "muted", label: t.providers.keyNone }
    : sessionKey
      ? { tone: "ok", label: maskKey(sessionKey) }
      : envSet
        ? { tone: "ok", label: `${MASK.slice(0, 4)} ${t.providers.keyEnv}` }
        : { tone: "warn", label: t.providers.keyMissing };
  const models = provider.models.length > 0 ? provider.models : [provider.defaultModel];

  useEffect(() => setTest(undefined), [provider.baseUrl, sessionKey]);

  const runTest = async () => {
    setTest("running");
    try {
      const definition = piRuntimeConfigurationForProvider(provider).providerDefinition;
      if (!definition) throw new Error("No provider definition.");
      const result = await testProviderConnection(definition, sessionKey || undefined);
      setTest(result);
      if (result.ok && result.models.length > 0) {
        onUpdate({
          models: result.models,
          ...(result.models.includes(provider.defaultModel) ? {} : { defaultModel: result.models[0] }),
        });
      }
    } catch (error) {
      setTest({ ok: false, models: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row settings-model-row">
        <ProviderMark label={provider.label} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title">
            <strong>{provider.label}</strong>
            {isDefault ? <span className="settings-chip" data-tone="accent">{t.providers.default}</span> : null}
          </span>
          <span className="settings-row-sub">{hostOf(provider.baseUrl)} · {t.providers.models(models.length)} · {provider.defaultModel}</span>
        </button>
        <span className="settings-key-pill" data-tone={keyState.tone}><Dot />{keyState.label}</span>
        <Switch
          size="sm"
          aria-label={`${t.providers.enabled} ${provider.label}`}
          checked
          disabled={onlyOne || isDefault || isRunning}
          title={onlyOne || isDefault ? t.providers.keepOne : undefined}
          onCheckedChange={(checked) => {
            if (!checked) onUpdate({ enabled: false });
          }}
        />
        <button type="button" className="settings-chevron" aria-label={provider.label} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <Field label={t.providers.baseUrl}>
            <Input value={provider.baseUrl} onChange={(event) => onUpdate({ baseUrl: event.target.value })} />
          </Field>
          {provider.auth.mode !== "none" ? (
            <>
              <Field label={t.providers.envVar}>
                <div className="settings-field-row">
                  <Input
                    value={envVar}
                    onChange={(event) => onUpdate({ authEnvVar: event.target.value })}
                    onBlur={(event) => {
                      if (!isSafeProviderEnvVarName(event.currentTarget.value)) {
                        onUpdate({ authEnvVar: safeProviderEnvVarName(provider) });
                      }
                    }}
                  />
                  <span className="settings-status" data-tone={envSet ? "ok" : "muted"}>
                    <Dot />{envSet ? t.providers.envFound : t.providers.envMissing}
                  </span>
                </div>
              </Field>
              <Field label={t.providers.sessionKey} hint={envSet && !sessionKey ? t.providers.envKeyHint : t.providers.sessionKeyHint}>
                <div className="settings-field-row">
                  <Input
                    type={revealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={envSet ? MASK : t.providers.sessionKeyPlaceholder}
                    value={sessionKey}
                    onChange={(event) => onSessionKeyChange(event.target.value.trim())}
                  />
                  {envSet && !sessionKey ? <span className="settings-status" data-tone="ok"><Dot />{t.providers.envKeySet}</span> : null}
                  <Button size="sm" variant="ghost" onClick={() => setRevealed((value) => !value)}>
                    {revealed ? t.providers.hide : t.providers.show}
                  </Button>
                </div>
              </Field>
            </>
          ) : null}
          <Field label={t.providers.defaultModel}>
            <div className="settings-field-row">
              <SelectMenu
                ariaLabel={t.providers.defaultModel}
                value={provider.defaultModel}
                options={models.map((model) => ({ value: model, label: model }))}
                onValueChange={(value) => onUpdate({ defaultModel: value })}
              />
              <Button size="sm" variant="ghost" disabled={test === "running"} onClick={() => void runTest()}>
                {t.providers.fetchModels}
              </Button>
            </div>
          </Field>
          <div className="settings-provider-actions">
            <Button size="sm" disabled={test === "running"} onClick={() => void runTest()}>
              {test === "running" ? t.providers.testing : t.providers.test}
            </Button>
            {test && test !== "running" ? (
              <span className="settings-status" data-tone={test.ok ? latencyTone(test.latencyMs) : "error"} role="status">
                <Dot />
                {test.ok
                  ? t.providers.testOk(test.latencyMs ?? 0, test.models.length)
                  : t.providers.testFail(test.error ?? `HTTP ${test.status ?? "?"}`)}
              </span>
            ) : null}
            <span className="settings-spacer" />
            {!isDefault ? <Button size="sm" variant="ghost" onClick={onSetDefault}>{t.providers.setDefault}</Button> : null}
          </div>
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
              <span className="settings-row-sub">{hint(mode === "host" ? hostMode : mode)}</span>
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
  const roleCopy = useCopy().composer.agentSettings;
  const [granted, setGranted] = useState<Record<string, string[]>>(runtime?.alwaysAllowed ?? {});
  useEffect(() => setGranted(runtime?.alwaysAllowed ?? {}), [runtime?.alwaysAllowed]);
  const agents = AGENT_PRESETS.filter((preset) => granted[preset.id]?.length);
  if (agents.length === 0) return <p className="settings-intro">{t.permissions.alwaysEmpty}</p>;
  return (
    <div className="settings-list">
      {agents.map((preset) => (
        <div className="settings-row" key={preset.id}>
          <span className="settings-row-main">
            <span className="settings-row-title"><strong>{roleCopy.presets[preset.id].name}</strong></span>
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
  const roleCopy = useCopy().composer.agentSettings;
  const agents = runtime?.workspace?.agents ?? {};
  const rows: [string, string][] = [
    ...AGENT_PRESETS.map((preset): [string, string] => [roleCopy.presets[preset.id].name, agents[preset.id] ?? runtime?.cwd ?? "—"]),
    ...(runtime?.workspace?.shared ? [[t.permissions.shared, runtime.workspace.shared] as [string, string]] : []),
  ];
  return (
    <div className="settings-list">
      {rows.map(([label, path]) => (
        <div className="settings-row settings-about-row" key={label}>
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
  const roleCopy = useCopy().composer.agentSettings;
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
        <ProviderMark label={name} />
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{name}</strong></span>
          <span className="settings-row-sub">
            {channel.status.botName ? `${channel.status.botName} · ` : ""}{roleCopy.presets[channel.agentPreset].name} · {channel.access === "open" ? c.open : c.allowlist}
          </span>
        </button>
        <span className="settings-key-pill" data-tone={tone}><Dot />{c.state[channel.status.state]}</span>
        <Switch
          size="sm"
          aria-label={`${name} ${c.state.connected}`}
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
              value={channel.agentPreset}
              options={AGENT_PRESETS.map((preset) => ({ value: preset.id, label: roleCopy.presets[preset.id].name }))}
              onValueChange={(value) => save({ agentPreset: value as ChannelView["agentPreset"] })}
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
  const [expanded, setExpanded] = useState<string | undefined>();
  return (
    <>
      <p className="settings-intro">{t.routines.intro}</p>
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
          <span className="settings-row-sub"><code>{routine.schedule}</code> · {routine.timezone}{when ? ` · ${when}` : ""}</span>
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
            <span className="settings-row-sub">{host} · {server.status === "ready" ? c.tools(server.tools.length) : server.error ?? c.state[server.status]}</span>
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

function MemorySection({ t, state }: { t: SettingsCopy; state: MemoriesState }) {
  const c = t.memory;
  const [draft, setDraft] = useState("");
  const memory = state.memory;
  const memories = [...(memory?.memories ?? [])].reverse();
  const addFailure = state.actionError?.id === "new" ? state.actionError.message : undefined;
  const add = async () => { if (draft.trim() && await state.save(undefined, draft)) setDraft(""); };
  return (
    <>
      <p className="settings-intro">{c.intro}</p>
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
      {memory && !memory.enabled ? <p className="settings-status" data-tone="warn" role="note"><Dot />{c.off}</p> : null}
      {memory && memories.length === 0 ? <p className="settings-note">{c.empty}</p> : null}
      {memories.length ? (
        <div className="settings-list">
          {memories.map((item) => <MemoryRow key={item.id} t={t} memory={item} state={state} />)}
        </div>
      ) : null}
      {memory ? (
        <div className="settings-field-row">
          <Input value={draft} maxLength={MEMORY_TEXT_LIMIT} placeholder={c.addPlaceholder} aria-label={c.addPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void add(); }} />
          <Button size="sm" disabled={!draft.trim() || state.busy === "new"} onClick={() => void add()}>{c.add}</Button>
        </div>
      ) : null}
      {addFailure ? <span className="settings-status" data-tone="error" role="status"><Dot />{c.failed(addFailure)}</span> : null}
    </>
  );
}

function MemoryRow({ t, memory, state }: { t: SettingsCopy; memory: MemoryView; state: MemoriesState }) {
  const c = t.memory;
  const { locale } = useLocale();
  const agents = useCopy().composer.agentSettings.presets;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [confirming, setConfirming] = useState(false);
  const busy = state.busy === memory.id;
  const failure = state.actionError?.id === memory.id ? state.actionError.message : undefined;
  const when = new Date(memory.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const save = async () => { if (await state.save(memory.id, text)) setEditing(false); };
  return (
    <div className="settings-row settings-memory-row">
      <span className="settings-row-main">
        {editing ? (
          <Input value={text} maxLength={MEMORY_TEXT_LIMIT} autoFocus aria-label={c.edit} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setText(memory.text); setEditing(false); }
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
            }} />
        ) : <span className="settings-row-title">{memory.text}</span>}
        <span className="settings-row-sub">{memory.source ? c.savedBy(agents[memory.source.agent].name, when) : c.addedByYou(when)}</span>
        {failure ? <span className="settings-status" data-tone="error" role="status"><Dot />{c.failed(failure)}</span> : null}
      </span>
      {editing ? (
        <>
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void save()}>{c.save}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setText(memory.text); setEditing(false); }}>{c.cancel}</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setText(memory.text); setEditing(true); }}>{c.edit}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onBlur={() => setConfirming(false)}
            onClick={() => { if (confirming) void state.remove(memory.id); else setConfirming(true); }}>
            {confirming ? c.confirmRemove : c.remove}
          </Button>
        </>
      )}
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

function maskKey(key: string): string {
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** CC Switch's latency bands. */
function latencyTone(ms = 0): "ok" | "warn" | "error" {
  if (ms < 500) return "ok";
  if (ms < 800) return "warn";
  return "error";
}
