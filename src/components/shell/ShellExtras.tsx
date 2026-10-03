import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Settings } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { AgentAvatar, type AvatarKind } from "../../avatars/AgentPersona";
import { useCopy, useLocale } from "../../i18n/LocaleContext";
import { settingsCopy } from "../../i18n/copy/settings";
import { appVersionLabel } from "../../appVersion";
import {
  AGENT_PRESETS,
  agentPreset,
  type AgentHarnessId,
  type AgentHarnessStatus,
  type AgentPresetId,
  type AgentSettings,
  type CliModelSource,
} from "../../pi/harnessCatalog";
import "./shell.css";

/**
 * Product chrome the exported layout has no slot for: the agent list in the sidebar, the
 * sidebar footer with Settings, and the current agent in the chat header. Patterns follow
 * OpenDots (agents listed in the sidebar, settings in its footer, the agent shown above the
 * conversation) and nightly openbot (status dot per agent; ideas only).
 *
 * Supplied through context so the slot registry stays unchanged; without a provider the
 * sidebar and header render exactly as exported.
 */
export type ShellExtras = {
  agentSwitcher?: ReactNode;
  sidebarFooter?: ReactNode;
  headerAgent?: ReactNode;
  /** Conversation id → the face of the role that answered it. */
  sessionAvatars?: Record<string, AvatarKind>;
  /** Composer placeholder naming the current agent. */
  composerPlaceholder?: string;
};

const ShellExtrasContext = createContext<ShellExtras>({});

export function ShellExtrasProvider({ value, children }: { value: ShellExtras; children: ReactNode }) {
  return <ShellExtrasContext.Provider value={value}>{children}</ShellExtrasContext.Provider>;
}

export function useShellExtras(): ShellExtras {
  return useContext(ShellExtrasContext);
}

export const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI" };

type AgentStatus = "idle" | "running" | "needs-you" | "unavailable";

export function AgentSwitcher({
  avatars,
  activeId,
  status,
  harnesses,
  disabled,
  onSelect,
}: {
  avatars: Record<AgentPresetId, AvatarKind>;
  activeId: AgentPresetId;
  /** State of the active agent's run. */
  status: "idle" | "running" | "needs-you";
  harnesses?: readonly AgentHarnessStatus[];
  disabled?: boolean;
  onSelect: (id: AgentPresetId) => void;
}) {
  const { locale } = useLocale();
  const t = settingsCopy[locale].shell;
  const roles = useCopy().composer.agentSettings.presets;
  return (
    <section className="shell-agents" aria-label={t.agents}>
      <h4 className="shell-agents-title">{t.agents}</h4>
      {AGENT_PRESETS.map((preset) => {
        const available = harnesses?.find((entry) => entry.id === preset.harness)?.available !== false;
        const active = preset.id === activeId;
        const rowStatus: AgentStatus = !available ? "unavailable" : active ? status : "idle";
        const statusLabel = rowStatus === "running" ? t.running : rowStatus === "needs-you" ? t.needsYou : rowStatus === "unavailable" ? t.notInstalled : undefined;
        return (
          <button
            type="button"
            key={preset.id}
            className="shell-agent"
            data-active={active}
            aria-current={active ? "true" : undefined}
            disabled={disabled || !available}
            title={active ? undefined : t.switchHint}
            onClick={() => onSelect(preset.id)}
          >
            <span className="shell-agent-face">
              <AgentAvatar size={26} kind={avatars[preset.id]} />
              <span className="shell-agent-dot" data-status={rowStatus} aria-hidden="true" />
            </span>
            <span className="shell-agent-text">
              <span className="shell-agent-name">{roles[preset.id].name}</span>
              <span className="shell-agent-sub">{statusLabel ?? HARNESS_LABELS[preset.harness]}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function SidebarFooter({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { locale } = useLocale();
  const t = settingsCopy[locale].shell;
  return (
    <footer className="shell-sidebar-footer">
      <button type="button" className="shell-footer-button" onClick={onOpenSettings}>
        <Settings size={16} aria-hidden="true" />
        <span>{t.settings}</span>
      </button>
      <span className="shell-footer-version">{appVersionLabel}</span>
    </footer>
  );
}

/** The current agent above the conversation; its popover holds that agent's model source. */
export function HeaderAgent({
  avatars,
  settings,
  providerLabel,
  disabled,
  onChange,
  onManageProviders,
}: {
  avatars: Record<AgentPresetId, AvatarKind>;
  settings: AgentSettings;
  /** e.g. "DeepSeek · deepseek-flash" */
  providerLabel: string;
  disabled?: boolean;
  onChange: (settings: AgentSettings) => void;
  onManageProviders: () => void;
}) {
  const { locale } = useLocale();
  const t = settingsCopy[locale];
  const roleCopy = useCopy().composer.agentSettings;
  const preset = agentPreset(settings.presetId);
  const sourceKey = preset.harness === "claude-code" ? "claudeCodeModelSource" : preset.harness === "codex" ? "codexModelSource" : undefined;
  const source: CliModelSource | undefined = sourceKey ? settings[sourceKey] : undefined;
  const model = !sourceKey || source === "provider" ? providerLabel : sourceKey === "claudeCodeModelSource" ? t.agents.sourceLocal : t.agents.sourceLocalCodex;

  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        <button type="button" className="shell-header-agent">
          <AgentAvatar size={28} kind={avatars[preset.id]} />
          <span className="shell-header-text">
            <strong>{roleCopy.presets[preset.id].name}</strong>
            <span>{HARNESS_LABELS[preset.harness]} · {model}</span>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="shell-popover" align="start" sideOffset={8} collisionPadding={12}>
          <p className="shell-popover-lead">{roleCopy.presets[preset.id].description}</p>
          {sourceKey ? (
            <div className="shell-popover-field">
              <span>{t.shell.modelSource}</span>
              <div className="settings-segmented" role="radiogroup" aria-label={t.shell.modelSource}>
                {(["provider", "local-login"] as const).map((value) => (
                  <button
                    type="button"
                    role="radio"
                    key={value}
                    aria-checked={source === value}
                    disabled={disabled}
                    onClick={() => onChange({ ...settings, [sourceKey]: value })}
                  >
                    {value === "provider"
                      ? `${t.agents.sourceProvider} · ${providerLabel.split(" · ")[0]}`
                      : sourceKey === "claudeCodeModelSource" ? t.agents.sourceLocal : t.agents.sourceLocalCodex}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {preset.harness === "codex" ? <p className="shell-popover-note">{roleCopy.codexModelNote}</p> : null}
          <button type="button" className="shell-popover-link" onClick={onManageProviders}>{t.shell.manageProviders}</button>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
