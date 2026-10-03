import * as RadixDialog from "@radix-ui/react-dialog";
import { Check, ChevronDown, Copy, Info, Palette, Plus, Server, ShieldCheck, X } from "lucide-react";
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
import "./settings.css";

/**
 * Settings, as one dialog with a section rail. Layout and row patterns follow magpie
 * (name + muted sub-line + control on the right, masked key pill, inline test result) and
 * CC Switch (provider presets that only need a key, CLI status cards, latency colours).
 * Every change applies at once; there is no Save button.
 */

export type PermissionMode = "request" | "auto" | "allow-all";
export type ProviderPatch = Partial<Pick<ProviderConnection, "baseUrl" | "defaultModel" | "models" | "enabled">> & {
  authEnvVar?: string;
};

export type SettingsSectionId = "providers" | "permissions" | "appearance" | "about";
type SectionId = SettingsSectionId;

const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI" };
const INSTALL_COMMANDS: Partial<Record<AgentHarnessId, string>> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};
const LOCALE_LABELS: Record<AppLocale, string> = { zh: "中文", en: "English", ja: "日本語" };

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section shown when the dialog opens. */
  initialSection?: SettingsSectionId;
  project: AgentFrontendProject;
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
  t, project, runtime, sessionKeys, onSessionKeyChange, onUpdateProvider, onSetDefaultProvider, isRunning,
}: SectionProps) {
  const [expanded, setExpanded] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const enabled = project.providers.connections.filter((provider) => provider.enabled);
  const available = project.providers.connections.filter((provider) => !provider.enabled);
  const defaultId = defaultProviderConnection(project).id;

  return (
    <>
      <p className="settings-intro">{t.providers.intro}</p>
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
        ? { tone: "ok", label: t.providers.keyEnv }
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
      <div className="settings-row">
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
              <Field label={t.providers.sessionKey} hint={t.providers.sessionKeyHint}>
                <div className="settings-field-row">
                  <Input
                    type={revealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t.providers.sessionKeyPlaceholder}
                    value={sessionKey}
                    onChange={(event) => onSessionKeyChange(event.target.value.trim())}
                  />
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
            <span className="settings-theme-swatch" style={{ background: theme.surface.canvas, borderColor: theme.border.strong }}>
              <span style={{ background: theme.surface.panel }} />
              <span style={{ background: theme.accent.action }} />
            </span>
            <span className="settings-theme-name">{theme.name}</span>
            <span className="settings-row-sub">{theme.appearance === "dark" ? t.appearance.dark : t.appearance.light}</span>
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="settings-copy"
      aria-label={copied ? t.copied : t.copy}
      title={copied ? t.copied : t.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
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
