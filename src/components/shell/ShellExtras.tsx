import { featureText, featureError, groupRosterTitle } from "../../i18n/copy/features.ts";
import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Pencil, Plus, Settings } from "lucide-react";
import { createContext, useContext, useRef, useState, type ReactNode, type RefObject } from "react";
import type { TranscriptScroll } from "../../runtime/useTranscriptScroll";
import type { BranchAction } from "../../runtime/useMessageBranch";
import type { ConversationSearch, SearchSession } from "../../runtime/useConversationSearch";
import type { useSessionHistoryGroups } from "../../runtime/useSessionHistoryGroups";
import type { TaskRecoveryActions } from "../../runtime/useTaskRecovery";

import { AgentAvatar, type AgentPersona, type AvatarKind } from "../../avatars/AgentPersona";
import { GroupFace } from "../../avatars/GroupFace";
import { useCopy, useLocale } from "../../i18n/LocaleContext";
import { settingsCopy } from "../../i18n/copy/settings";
import { appVersionLabel } from "../../appVersion";
import type { ComposerDraft, ComposerRunOptions } from "../agent-preview/ComposerFrame";
import type { OutputPanelOpenRequest } from "../agent-preview/outputframe/panelItem";
import type { OutputPanelSource } from "../agent-preview/outputframe/types";
import type { ArtifactCatalogContext } from "../../runtime/artifactCatalog";
import type { PiRuntimeState } from "../../pi/piClient";
import type { ProviderConnectionId } from "../../schema/agentuxConfig";
import {
  AGENT_PRESETS,
  agentPreset,
  type AgentHarnessId,
  type AgentHarnessStatus,
  type AgentPresetId,
  type AgentSettings,
  type CliModelSource,
} from "../../pi/harnessCatalog";
import { HarnessMark } from "./HarnessMark";
import { Button } from "../ui/button";
import "./shell.css";
import { BotEditor, type BotEditorState } from "./BotEditor";
import { BOT_NAMES, type BotProfile } from "../../runtime/botProfiles";

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
  taskRecovery?: TaskRecoveryActions;
  artifactCatalog?: ArtifactCatalogContext;
  botEditor?: BotEditorState;
  bots?: readonly BotProfile[];
  onCreateBot?: () => void;
  onEditBot?: (bot: BotProfile) => void;
  botError?: string;
  sessionBotIds?: Record<string, string>;
  agentSwitcher?: ReactNode;
  /** Group chat: replaces the welcome greeting for a new group (its face, names and "To:" picker). */
  welcomeGroup?: ReactNode;
  /** Group chat: an action in the sidebar header (the "+" menu). */
  sidebarAction?: ReactNode;
  /** Group chat: the group member working on this turn who has not shown any output yet. */
  groupTyping?: string;
  groupHostId?: string;
  /** Group chat: untitled group id (title is still the roster) → last message, shown as the row title. */
  groupPreviews?: Record<string, string>;
  /** Group chat: group conversation id → its members' faces. */
  groupFaces?: Record<string, AvatarKind[]>;
  sidebarFooter?: ReactNode;
  headerAgent?: ReactNode;
  /** Conversation id → the face of the role that answered it. */
  sessionAvatars?: Record<string, AvatarKind>;
  /** Optional Bot grouping; standalone previews keep their existing date groups. */
  historyGroups?: ReturnType<typeof useSessionHistoryGroups>;
  searchConversations?: ConversationSearch;
  onSelectSearchResult?: (session: SearchSession) => void;
  /** Deletes a saved conversation after the row's inline confirmation; omitted, rows have no delete. */
  onDeleteSession?: (id: string) => Promise<void>;
  /** Renames a saved conversation from the row's inline field; omitted, rows have no rename. */
  onRenameSession?: (id: string, title: string) => Promise<void>;
  /** Conversations with a run in flight: the host refuses to delete or rename them. */
  runningSessionIds?: ReadonlySet<string>;
  /** Drafts nothing has been sent from yet: no saved title to rename. */
  unsentSessionIds?: ReadonlySet<string>;
  transcriptTarget?: { textId: string; nonce: string };
  /** Composer placeholder naming the current agent. */
  composerPlaceholder?: string;
  /** One model-menu choice is one host transaction; legacy previews keep their callbacks. */
  providerSelection?: { onChange: (providerId: ProviderConnectionId, model: string) => void; error?: string;
    selected?: { providerId: string; model: string } };
  /** Live work above the input; an empty persona leaves a stable, quiet gap after completion. */
  composerActivity?: { scope: string; persona?: AgentPersona };
  /** Group chat: members the composer offers after "@", in group order. */
  composerMentions?: readonly { id: string; name: string; handle?: string; presetId?: AgentPresetId; kind: AvatarKind }[];
  /** Saved conversations the user may explicitly attach as context for a new turn. */
  chatReferences?: readonly { id: string; title: string }[];
  /** The shell keeps each conversation's files and draft across layout remounts. */
  composerDraft?: { value: ComposerDraft; status?: "loading" | "saving" | "saved" | "unavailable" | "conflict"; onChange: (update: (current: ComposerDraft) => ComposerDraft) => void };
  /** Follow-ups typed while a turn runs. The shell owns order, sending and pausing; the composer only shows and edits. */
  composerQueue?: {
    items: readonly { id: string; prompt: string; attachmentCount: number }[];
    paused?: "stopped" | "failed" | "restored";
    canEnqueue: boolean;
    canEdit: boolean;
    inputScope?: string;
    onSteer?: (text: string, requestId: string) => Promise<void>;
    onEnqueue: (options: ComposerRunOptions) => void;
    onRemove: (id: string) => void;
    onEdit: (id: string) => void;
    onResume: () => void;
  };
  /** Explicit choices belong to the conversation, not a remountable layout slot. */
  composerOptions?: { value: ComposerRunOptions; onChange: (update: Partial<ComposerRunOptions>) => void };
  composerFocus?: string;
  stopStatus?: "pending" | "failed" | "idle";
  messageBranch?: { canBranch: (messageId?: string) => boolean; run: (messageId: string, action: BranchAction) => Promise<void> };
  /** Layout switches may remount the transcript while the user is reading history. */
  transcriptScroll?: RefObject<TranscriptScroll | undefined>;
  toolLog?: { targetId?: string; revision?: number; open(toolId: string): void };
  runActive?: ReadonlySet<string>;
  workspaceScope?: AgentPresetId;
  workspaceBotName?: string;
  /** The shared browser's live view in the Output panel (ADR-040); absent when the host has none. */
  outputPanel?: { source: OutputPanelSource; select(source: OutputPanelSource): void; browserAvailable: boolean };
  /** Refresh the visible directory when a run starts or finishes. */
  workspaceRevision?: boolean;
  workspaceSharedAvailable?: boolean;
  workspace?: PiRuntimeState["workspace"];
  onBrowseWorkspace?: () => void;
  onAttachWorkspaceFile?: (file: import("../../pi/piClient").PiFileReference) => Promise<void>;
  onOpenFile?: (request: OutputPanelOpenRequest) => void;
  /** A follow-up the user clicked for inside an HTML artifact; it joins the visible queue. */
  onArtifactPrompt?: (text: string) => void;
  /** The current theme as CSS for HTML artifacts, from theme state rather than the DOM. */
  artifactThemeCss?: string;
  artifactForms?: {
    conversationId: string;
    result(requestId: string): "queued" | "running" | "completed" | "failed" | undefined;
    openResult(requestId: string): void;
    submit(requestId: string, prompt: string, artifactId: string): Promise<void>;
  };
};

const ShellExtrasContext = createContext<ShellExtras>({});

export function ShellExtrasProvider({ value, children }: { value: ShellExtras; children: ReactNode }) {
  return <ShellExtrasContext.Provider value={value}>{children}{value.botEditor ? <BotEditor {...value.botEditor} /> : null}</ShellExtrasContext.Provider>;
}

export function useShellExtras(): ShellExtras {
  return useContext(ShellExtrasContext);
}

export const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI", dsh: "DeepSeek Harness" };

/** State of an agent's runs: any of its conversations may be in flight, on screen or not. */
export type AgentRunStatus = "idle" | "running" | "needs-you";
type AgentStatus = AgentRunStatus | "unavailable";

export function AgentSwitcher({
  avatars,
  activeId,
  statuses,
  harnesses,
  disabled,
  onSelect,
  groupActive,
  bots,
  activeBotId,
  onSelectBot,
  onEditBot,
}: {
  bots?: readonly BotProfile[];
  activeBotId?: string;
  onSelectBot?: (bot: BotProfile) => void;
  onEditBot?: (bot: BotProfile) => void;
  groupActive?: boolean;
  avatars: Record<AgentPresetId, AvatarKind>;
  activeId: AgentPresetId;
  statuses: Partial<Record<string, AgentRunStatus>>;
  harnesses?: readonly AgentHarnessStatus[];
  disabled?: boolean;
  onSelect: (id: AgentPresetId) => void;
}) {
  const { locale } = useLocale();
  const t = settingsCopy[locale].shell;
  const roles = useCopy().composer.agentSettings.presets;
  const choices = bots ?? AGENT_PRESETS.filter(preset => preset.id !== "dsh").map(preset => ({ ...preset, presetId: preset.id, name: roles[preset.id].name, appearance: undefined }));
  return (
    <section className="shell-agents" data-manage={bots ? "true" : undefined} aria-label={t.agents}>
      <h4 className="shell-agents-title">{t.agents}</h4>
      {choices.map((bot) => {
        const preset = agentPreset(bot.presetId);
        const available = harnesses?.find((entry) => entry.id === preset.harness)?.available !== false;
        const active = !groupActive && bot.id === (activeBotId ?? activeId);
        const rowStatus: AgentStatus = !available ? "unavailable" : statuses[bot.id] ?? "idle";
        const statusLabel = rowStatus === "running" ? t.running : rowStatus === "needs-you" ? t.needsYou : rowStatus === "unavailable" ? t.notInstalled : undefined;
        return (
          <div className="shell-agent-row" key={bot.id}>
          <button
            type="button"
            className="shell-agent"
            data-active={active}
            aria-current={active ? "true" : undefined}
            aria-disabled={disabled || !available || undefined}
            title={onEditBot ? (featureText(locale, "Click to chat, right-click to edit Bot")) : t.switchHint}
            onClick={() => { if (!disabled && available) { if (onSelectBot && bot.appearance) onSelectBot(bot as BotProfile); else onSelect(preset.id); } }}
            onContextMenu={event => { if (onEditBot && bot.appearance) { event.preventDefault(); event.currentTarget.focus(); onEditBot(bot as BotProfile); } }}
            onKeyDown={event => { if (onEditBot && bot.appearance && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); onEditBot(bot as BotProfile); } }}
          >
            <span className="shell-agent-face" data-status={rowStatus}>
              <AgentAvatar size={42} kind={avatars[preset.id]} appearance={bot.appearance} />
              <span className="shell-agent-dot" data-status={rowStatus} aria-hidden="true" />
            </span>
            <span className="shell-agent-text">
              <span className="shell-agent-name">{bot.name}</span>
              <span className="shell-agent-sub">
                {statusLabel ?? (
                  <>
                    <HarnessMark harness={preset.harness} />
                    {HARNESS_LABELS[preset.harness]}
                  </>
                )}
              </span>
            </span>
          </button>
          {onEditBot && bot.appearance ? <button type="button" className="shell-agent-edit" aria-label={`${featureText(locale, "Edit")} ${bot.name}`}
            onClick={() => onEditBot(bot as BotProfile)}><Pencil size={14} /></button> : null}
          </div>
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
  providerName,
  disabled,
  onChange,
  onManageProviders,
  bot,
  onEditBot,
  onManageBot,
}: {
  bot?: BotProfile;
  onEditBot?: (bot: BotProfile) => void;
  onManageBot?: (section: "memory" | "routines") => void;
  avatars: Record<AgentPresetId, AvatarKind>;
  settings: AgentSettings;
  /** Display label; never parse UI punctuation to obtain the provider name. */
  providerLabel: string;
  providerName?: string;
  disabled?: boolean;
  onChange: (settings: AgentSettings) => void;
  onManageProviders: () => void;
}) {
  const { locale } = useLocale();
  const t = settingsCopy[locale];
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingSettings = useRef(false);
  const manage = (action: () => void) => {
    openingSettings.current = true;
    setMenuOpen(false);
    trigger.current?.focus();
    action();
  };
  const roleCopy = useCopy().composer.agentSettings;
  const preset = agentPreset(settings.presetId);
  const name = bot?.name ?? BOT_NAMES[preset.id];
  const sourceKey = preset.harness === "claude-code" ? "claudeCodeModelSource" : preset.harness === "codex" ? "codexModelSource" : undefined;
  const source: CliModelSource | undefined = sourceKey ? settings[sourceKey] : undefined;
  const model = !sourceKey || source === "provider" ? providerLabel : sourceKey === "claudeCodeModelSource" ? t.agents.sourceLocal : t.agents.sourceLocalCodex;

  return (
    <RadixPopover.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <RadixPopover.Trigger asChild>
        <button ref={trigger} type="button" className="shell-header-agent shell-header-compact" aria-label={`${name}, ${HARNESS_LABELS[preset.harness]}`}
          onContextMenu={event => { if (bot && onEditBot) { event.preventDefault(); event.currentTarget.focus(); onEditBot(bot); } }}>
          <AgentAvatar size={28} kind={avatars[preset.id]} appearance={bot?.appearance} live={false} />
          <strong className="shell-header-name">{name}</strong>
          <span className="shell-header-engine" title={HARNESS_LABELS[preset.harness]}>
            <HarnessMark harness={preset.harness} size={14} />
          </span>
          <ChevronDown className="shell-header-chevron" size={12} aria-hidden="true" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={`shell-popover${sourceKey ? "" : " shell-model-popover"}`} align="center" sideOffset={8} collisionPadding={12}
          onCloseAutoFocus={event => { if (openingSettings.current) { event.preventDefault(); openingSettings.current = false; } }}>
          {bot && onEditBot ? <button type="button" className="shell-popover-link" onClick={() => manage(() => onEditBot(bot))}>{featureText(locale, "Edit this Bot")}</button> : null}
          {onManageBot ? <>
            <button type="button" className="shell-popover-link" onClick={() => manage(() => onManageBot("memory"))}>{featureText(locale, "This Bot’s memories")}</button>
            <button type="button" className="shell-popover-link" onClick={() => manage(() => onManageBot("routines"))}>{featureText(locale, "This Bot’s routines")}</button>
          </> : null}
          <p className="shell-header-model">{model}</p>
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
                    disabled={disabled || Boolean(bot?.model)}
                    onClick={() => onChange({ ...settings, [sourceKey]: value })}
                  >
                    {value === "provider"
                      ? `${t.agents.sourceProvider} (${providerName ?? providerLabel})`
                      : sourceKey === "claudeCodeModelSource" ? t.agents.sourceLocal : t.agents.sourceLocalCodex}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {preset.harness === "codex" ? <p className="shell-popover-note">{roleCopy.codexModelNote}</p> : null}
          <button type="button" className="shell-popover-link" onClick={() => manage(onManageProviders)}>{t.shell.manageProviders}</button>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

// ---------- Group chat: "+" menu, To: picker, group header with member panel ----------
const GROUP_ROLE = { assistant: "Assistant", planner: "Planner", builder: "Builder", dsh: "General assistant" } as const;
const GROUP_NAME = BOT_NAMES;
function useGroupBots() {
  const { bots } = useShellExtras();
  return bots ?? AGENT_PRESETS.filter(preset => preset.id !== "dsh").map(preset => ({ id: preset.id, presetId: preset.id, name: GROUP_NAME[preset.id], appearance: undefined }));
}
export function useBotNames(): Record<string, string> {
  return Object.fromEntries(useGroupBots().map(bot => [bot.id, bot.name]));
}

/** Invite from the conversation header; the existing participants stay selected. */
export function NewChatMenu({ avatars, members, onNewGroup }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  members: readonly string[];
  onNewGroup: (members: string[]) => void | Promise<void>;
}) {
  const { locale } = useLocale();
  const candidates = useGroupBots();
  const botNames = useBotNames();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const ordered = candidates.map(p => p.id).filter((id) => members.includes(id) || picked.includes(id));
  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((m) => m !== id) : [...current, id]);
  const start = async () => {
    if (!picked.length || pending) return;
    setPending(true); setError(undefined);
    try { await onNewGroup(ordered); setOpen(false); setPicked([]); }
    catch (error) { setError(featureError(locale, error)); }
    finally { setPending(false); }
  };
  return (
    <RadixPopover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPicked([]); }}>
      <RadixPopover.Trigger asChild>
        <button type="button" className="rail-icon-btn shell-invite-agent" aria-label={featureText(locale, "Add agent")} title={featureText(locale, "Add an agent to the chat")}>
          <Plus size={16} />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="shell-popover shell-member-popover" align="start" sideOffset={6} collisionPadding={12}>
          <div className="shell-member-to">
            <span className="shell-member-meta">{featureText(locale, "Chat members")}</span>
            {ordered.length ? ordered.map((id) => (
              <span key={id} className="shell-member-chip" data-selected="true"><AgentAvatar size={18} kind={avatars[candidates.find(bot => bot.id === id)!.presetId]} />{botNames[id]}</span>
            )) : <span className="shell-member-meta">{featureText(locale, "Select one or more")}</span>}
          </div>
          {candidates.map((preset) => {
            const present = members.includes(preset.id);
            const on = present || picked.includes(preset.id);
            return (
              <button type="button" key={preset.id} className="shell-member-row"
                aria-pressed={on} disabled={present} onClick={() => toggle(preset.id)}>
                <AgentAvatar size={24} kind={avatars[preset.presetId]} appearance={preset.appearance} />
                <span>{botNames[preset.id]}</span>
                <span className="shell-member-meta shell-member-role">{present ? featureText(locale, "Joined") : featureText(locale, GROUP_ROLE[preset.presetId])}</span>
                <span aria-hidden="true" className="shell-member-check">{on ? "✓" : ""}</span>
              </button>
            );
          })}
          {error ? <p className="shell-member-note" role="alert">{error}</p> : null}
          <Button type="button" variant="primary" className="shell-member-start" disabled={!picked.length || pending} onClick={() => void start()}>
            {picked.length ? featureText(locale, "Add to chat ({count})", { count: picked.length }) : featureText(locale, "Select agents to add")}
          </Button>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}


/**
 * The group's top bar. Before the first message it is a "To:" picker; afterwards the group's face and
 * names, which open a member panel (roles, engines, add/remove for the next message).
 */
export function GroupHeader({ avatars, members, draft, onChange, hostId = members[0] }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  members: readonly string[];
  draft: boolean;
  hostId?: string;
  onChange: (members: string[]) => void | Promise<void>;
}) {
  const { locale } = useLocale();
  const candidates = useGroupBots();
  const botNames = useBotNames();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const toggle = async (id: string) => {
    if (pending || id === hostId) return;
    const next = members.includes(id) ? members.filter((m) => m !== id) : candidates.map(p => p.id).filter((m) => m === id || members.includes(m));
    if (!next.length) return;
    setPending(true); setError(undefined);
    try { await onChange(next); } catch (error) { setError(featureError(locale, error)); } finally { setPending(false); }
  };
  const names = groupRosterTitle(members.map(m => botNames[m]), locale);
  if (draft) {
    return (
      <div className="shell-member-picker">
        <span className="shell-member-meta">{featureText(locale, "Members")}</span>
        {candidates.map((preset) => (
          <button key={preset.id} type="button" className="shell-member-chip" aria-pressed={members.includes(preset.id)} disabled={pending || preset.id === hostId} onClick={() => void toggle(preset.id)}>
            <AgentAvatar size={20} kind={avatars[preset.presetId]} appearance={preset.appearance} />{botNames[preset.id]}
          </button>
        ))}
      </div>
    );
  }
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        <button type="button" className="shell-header-agent shell-header-compact" title={names}>
          <GroupFace size={34} kinds={members.map(m => avatars[candidates.find(bot => bot.id === m)!.presetId])} />
          <span className="shell-header-text">
            <strong>{names}</strong>
            <span>{featureText(locale, "Members: {count}", { count: members.length + 1 })}</span>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="shell-popover shell-member-popover" align="start" sideOffset={8} collisionPadding={12}>
          <div className="shell-member-note">{featureText(locale, "Chat members")}</div>
          {error ? <p className="shell-member-note" role="alert">{error}</p> : null}
          <div className="shell-member-row">
            <GroupFace size={24} kinds={[]} /><span>{featureText(locale, "Me")}</span><span className="shell-member-meta shell-member-role">{featureText(locale, "You")}</span>
          </div>
          {candidates.map((preset) => {
            const on = members.includes(preset.id);
            return (
              <button key={preset.id} type="button" className="shell-member-row" aria-pressed={on} disabled={pending || preset.id === hostId} onClick={() => void toggle(preset.id)}>
                <AgentAvatar size={24} kind={avatars[preset.presetId]} appearance={preset.appearance} />
                <span>{botNames[preset.id]} <span className="shell-member-meta">{featureText(locale, GROUP_ROLE[preset.presetId])}</span></span>
                <span className="shell-member-meta shell-member-role">
                  <HarnessMark harness={agentPreset(preset.presetId).harness} />{on ? featureText(locale, "In the group") : featureText(locale, "Removed")}
                </span>
              </button>
            );
          })}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** Group chat: the welcome area of a group that has no messages yet — who is in it, and who to add. */
export function GroupWelcome({ avatars, members, hostId, onChange }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  members: readonly string[];
  hostId?: string;
  onChange: (members: string[]) => void | Promise<void>;
}) {
  const { locale } = useLocale();
  const candidates = useGroupBots();
  const botNames = useBotNames();
  return (
    <div className="composer-greeting" style={{ flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
      <span aria-hidden="true"><GroupFace size={76} kinds={members.map(m => avatars[candidates.find(bot => bot.id === m)!.presetId])} /></span>
      <h2 className="composer-greeting-text" style={{ margin: 0 }}>{groupRosterTitle(members.map(m => botNames[m]), locale)}</h2>
      <p style={{ margin: 0, opacity: 0.6, fontSize: 14 }}>{featureText(locale, "Select members to start a conversation.")}</p>
      <GroupHeader avatars={avatars} members={members} hostId={hostId} draft onChange={onChange} />
    </div>
  );
}
