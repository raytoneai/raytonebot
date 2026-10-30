import * as RadixDialog from "@radix-ui/react-dialog";
import { Brain, CalendarClock, Info, KeyRound, MessagesSquare, Palette, Plug, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { featureText } from "../../i18n/copy/features.ts";
import type { LearningSettings } from "../../runtime/useLearning";

import { appVersionLabel } from "../../appVersion";
import { settingsCopy } from "../../i18n/copy/settings";
import { vaultCopy } from "../../i18n/copy/vault";
import { useLocale } from "../../i18n/LocaleContext";
import { type MemoryScope } from "../../pi/memoryTypes";
import { type PiRuntimeState } from "../../pi/piClient";
import type { RoutineDefinitionPatch, RoutineRun } from "../../pi/routineTypes";
import { type ProviderPatch } from "../../runtime/providerSettings";
import type { ImChannelsState } from "../../runtime/useImChannels";
import type { McpServersState } from "../../runtime/useMcpServers";
import type { MemoriesState } from "../../runtime/useMemories";
import { useProviderEditor } from "../../runtime/useProviderEditor";
import type { ProviderSettingsStatus } from "../../runtime/useProviderSettings";
import type { RoutinesState } from "../../runtime/useRoutines";
import type { SkillsState } from "../../runtime/useSkills";
import type { UsageViewState } from "../../runtime/useUsage";
import type { VaultSettingsState } from "../../runtime/useVault";
import { type AgentFrontendProject, type ProviderConnectionId } from "../../schema/agentuxConfig";
import { type ThemePresetId } from "../../theme/themeTokens";
import { Button } from "../ui";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ChannelsSection } from "./ChannelsSection";
import { LearningSection } from "./LearningSection";
import { McpSection } from "./McpSection";
import { MemorySection, memoryScopeKey } from "./MemorySection";
import { PermissionsSection, type PermissionMode } from "./PermissionsSection";
import { ProvidersSection } from "./ProvidersSection";
import { RoutinesSection } from "./RoutinesSection";
import "./settings.css";
import { SkillsSection } from "./SkillsSection";
import { UsageSection } from "./UsageSection";
import { VaultSection } from "./VaultSection";

/**
 * Settings, as one dialog with a section rail. Layout and row patterns follow magpie
 * (name + muted sub-line + control on the right, masked key pill, inline test result) and
 * CC Switch (provider presets that only need a key, CLI status cards, latency colours).
 * Model service edits stay in a dialog draft until Save. Provider secrets can be saved in the
 * host credential store; the UI states that boundary explicitly.
 */

export type { PermissionMode } from "./PermissionsSection";
export type { ProviderPatch } from "../../runtime/providerSettings";

export type SettingsSectionId = "providers" | "permissions" | "channels" | "routines" | "mcp" | "memory" | "vault" | "usage" | "appearance" | "about" | "developer";
type SectionId = SettingsSectionId;

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Section shown when the dialog opens. */
  initialSection?: SettingsSectionId;
  initialBotId?: string;
  initialMemoryScope?: MemoryScope;
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
  learning?: LearningSettings;
  /** Cross-conversation memory from the host (ADR-038); the section is hidden when absent (fixtures, static previews). */
  memories?: MemoriesState;
  memoryScopes?: { scope: MemoryScope; label: string }[];
  /** Public login metadata; absent in fixtures and static previews. */
  vault?: VaultSettingsState;
  /** Opens a routine's conversation and closes the dialog. */
  onOpenConversation?: (conversationId: string, target?: Pick<RoutineRun, "runId" | "textId">) => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  const { locale } = useLocale();
  const t = settingsCopy[locale];
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "providers");
  const [confirmClose, setConfirmClose] = useState(false);
  // Closing settings or changing sections keeps unsaved routine drafts for this page session.
  const [routineDrafts, setRoutineDrafts] = useState<Record<string, RoutineDefinitionPatch | undefined>>({});
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
    ...(props.mcpServers || props.skills ? [{ id: "mcp" as const, label: props.skills ? (featureText(locale, "MCP & Skills")) : t.nav.mcp, Icon: Plug }] : []),
    ...(props.memories ? [{ id: "memory" as const, label: t.nav.memory, Icon: Brain }] : []),
    ...(props.usage ? [{ id: "usage" as const, label: featureText(locale, "Model usage"), Icon: Info }] : []),
    ...(props.vault ? [{ id: "vault" as const, label: vaultCopy[locale].nav, Icon: KeyRound }] : []),
    { id: "appearance", label: t.nav.appearance, Icon: Palette },
    ...(props.learning ? [{ id: "developer" as const, label: featureText(locale, "Developer"), Icon: Brain }] : []),
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
                <ProvidersSection t={t} runtime={props.runtime} sessionKeys={editor.keys} isRunning={props.isRunning} providerSettingsStatus={props.providerSettingsStatus} savedProviderSettings={props.savedProviderSettings} project={{ ...props.project, providers: editor.providers }}
                  probeRevision={editor.revision} removeKeys={editor.removeKeys} onToggleRemoveKey={editor.toggleRemoveKey}
                  onUpdateProvider={editor.update} onSessionKeyChange={editor.setKey} onSetDefaultProvider={editor.setDefault} />
              </fieldset> : null}
              {section === "permissions" ? <PermissionsSection t={t} runtime={props.runtime} permissionDefault={props.permissionDefault} onPermissionDefaultChange={props.onPermissionDefaultChange} /> : null}
              {section === "channels" && props.imChannels ? <ChannelsSection t={t} state={props.imChannels} /> : null}
              {section === "routines" && props.routines ? <RoutinesSection key={props.initialBotId ?? "all"} t={t} state={props.routines} initialBotId={props.initialBotId} onOpenConversation={props.onOpenConversation}
                drafts={routineDrafts} onDraft={(id, draft) => setRoutineDrafts(current => ({ ...current, [id]: draft }))} /> : null}
              {section === "mcp" && props.mcpServers ? <McpSection t={t} state={props.mcpServers} /> : null}
              {section === "mcp" && props.skills ? <SkillsSection state={props.skills} /> : null}
              {section === "memory" && props.memories ? <MemorySection key={props.initialMemoryScope ? memoryScopeKey(props.initialMemoryScope) : "all"} t={t} state={props.memories} scopes={props.memoryScopes} initialScope={props.initialMemoryScope} /> : null}
              {section === "developer" && props.learning ? <LearningSection learning={props.learning} /> : null}
              {section === "usage" && props.usage ? <UsageSection usage={props.usage} /> : null}
              {props.open && section === "vault" && props.vault ? <VaultSection state={props.vault} /> : null}
              {section === "appearance" ? <AppearanceSection t={t} themePreset={props.themePreset} onThemeChange={props.onThemeChange} /> : null}
              {section === "about" ? <AboutSection t={t} runtime={props.runtime} /> : null}
            </div>
            {section === "providers" ? <footer className="settings-save-footer">
              <p className="settings-note">{t.providers.saveScope}</p>
              <div className="settings-save-actions">
                <span className="settings-status" role="status" data-tone={editor.invalid || editor.status === "failed" || editor.status === "conflict" ? "error" : editor.status === "saved" ? "ok" : "muted"}>
                  {editor.invalid ? `${editor.invalid.provider.label}：${editor.invalid.field === "modelOptions" ? (featureText(locale, "Check model options. Output cannot exceed the context window.")) : t.providers.validation[editor.invalid.field!]}`
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
