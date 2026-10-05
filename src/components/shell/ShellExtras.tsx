import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Settings } from "lucide-react";
import { createContext, useContext, useState, type ReactNode, type RefObject } from "react";
import type { TranscriptScroll } from "../../runtime/useTranscriptScroll";
import type { BranchAction } from "../../runtime/useMessageBranch";
import type { ConversationSearch, SearchSession } from "../../runtime/useConversationSearch";

import { AgentAvatar, type AvatarKind } from "../../avatars/AgentPersona";
import { GroupFace } from "../../avatars/GroupFace";
import { useCopy, useLocale } from "../../i18n/LocaleContext";
import { settingsCopy } from "../../i18n/copy/settings";
import { appVersionLabel } from "../../appVersion";
import type { ComposerDraft, ComposerRunOptions } from "../agent-preview/ComposerFrame";
import type { OutputPanelOpenRequest } from "../agent-preview/outputframe/panelItem";
import type { PiRuntimeState } from "../../pi/piClient";
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
  /** Group chat: replaces the welcome greeting for a new group (its face, names and "To:" picker). */
  welcomeGroup?: ReactNode;
  /** Group chat: an action in the sidebar header (the "+" menu). */
  sidebarAction?: ReactNode;
  /** Group chat: the group member working on this turn who has not shown any output yet. */
  groupTyping?: AgentPresetId;
  /** Group chat: untitled group id (title is still the roster) → last message, shown as the row title. */
  groupPreviews?: Record<string, string>;
  /** Group chat: group conversation id → its members' faces. */
  groupFaces?: Record<string, AvatarKind[]>;
  sidebarFooter?: ReactNode;
  headerAgent?: ReactNode;
  /** Conversation id → the face of the role that answered it. */
  sessionAvatars?: Record<string, AvatarKind>;
  searchConversations?: ConversationSearch;
  onSelectSearchResult?: (session: SearchSession) => void;
  /** Deletes a saved conversation after the row's inline confirmation; omitted, rows have no delete. */
  onDeleteSession?: (id: string) => Promise<void>;
  /** Conversations with a run in flight: the host refuses to delete them. */
  runningSessionIds?: ReadonlySet<string>;
  transcriptTarget?: { textId: string; nonce: string };
  /** Composer placeholder naming the current agent. */
  composerPlaceholder?: string;
  /** The shell keeps each conversation's files and draft across layout remounts. */
  composerDraft?: { value: ComposerDraft; status?: "loading" | "saving" | "saved" | "unavailable" | "conflict"; onChange: (update: (current: ComposerDraft) => ComposerDraft) => void };
  /** Follow-ups typed while a turn runs. The shell owns order, sending and pausing; the composer only shows and edits. */
  composerQueue?: {
    items: readonly { id: string; prompt: string; attachmentCount: number }[];
    paused?: "stopped" | "failed" | "restored";
    canEnqueue: boolean;
    canEdit: boolean;
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
  workspaceScope?: AgentPresetId;
  /** Refresh the visible directory when a run starts or finishes. */
  workspaceRevision?: boolean;
  workspaceSharedAvailable?: boolean;
  workspace?: PiRuntimeState["workspace"];
  onOpenFile?: (request: OutputPanelOpenRequest) => void;
};

const ShellExtrasContext = createContext<ShellExtras>({});

export function ShellExtrasProvider({ value, children }: { value: ShellExtras; children: ReactNode }) {
  return <ShellExtrasContext.Provider value={value}>{children}</ShellExtrasContext.Provider>;
}

export function useShellExtras(): ShellExtras {
  return useContext(ShellExtrasContext);
}

export const HARNESS_LABELS: Record<AgentHarnessId, string> = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI" };

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
  onNewGroup,
  groupActive,
  groupStatus,
}: {
  onNewGroup?: () => void;
  groupActive?: boolean;
  groupStatus?: AgentRunStatus;
  avatars: Record<AgentPresetId, AvatarKind>;
  activeId: AgentPresetId;
  statuses: Partial<Record<AgentPresetId, AgentRunStatus>>;
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
        const active = !groupActive && preset.id === activeId;
        const rowStatus: AgentStatus = !available ? "unavailable" : statuses[preset.id] ?? "idle";
        const statusLabel = rowStatus === "running" ? t.running : rowStatus === "needs-you" ? t.needsYou : rowStatus === "unavailable" ? t.notInstalled : undefined;
        return (
          <button
            type="button"
            key={preset.id}
            className="shell-agent"
            data-active={active}
            aria-current={active ? "true" : undefined}
            disabled={disabled || !available}
            title={t.switchHint}
            onClick={() => onSelect(preset.id)}
          >
            <span className="shell-agent-face" data-status={rowStatus}>
              <AgentAvatar size={26} kind={avatars[preset.id]} />
              <span className="shell-agent-dot" data-status={rowStatus} aria-hidden="true" />
            </span>
            <span className="shell-agent-text">
              <span className="shell-agent-name">{roles[preset.id].name}</span>
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
        );
      })}
      {onNewGroup ? (
        <button type="button" className="shell-agent" data-active={groupActive} aria-current={groupActive ? "true" : undefined}
          disabled={disabled} title="新建 Group：我、Raer、Tonny、Bob" onClick={onNewGroup}>
          {/* The 30px face overhangs a 26px slot so "Group" starts where the agent names do. */}
          <span className="shell-agent-face" data-status={groupStatus ?? "idle"} style={{ width: 26, justifyContent: "center" }}>
            <GroupFace size={30} kinds={[avatars.assistant, avatars.planner, avatars.builder]} />
            {groupStatus ? <span className="shell-agent-dot" data-status={groupStatus} aria-hidden="true" /> : null}
          </span>
          <span className="shell-agent-text">
            <span className="shell-agent-name">Group</span>
            <span className="shell-agent-sub">{groupStatus === "running" ? t.running : groupStatus === "needs-you" ? t.needsYou : "我 · Raer · Tonny · Bob"}</span>
          </span>
        </button>
      ) : null}
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
            <span><HarnessMark harness={preset.harness} />{HARNESS_LABELS[preset.harness]} · {model}</span>
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

// ---------- Group chat: "+" menu, To: picker, group header with member panel ----------
const GROUP_ROLE: Record<AgentPresetId, string> = { assistant: "助手", planner: "规划", builder: "实施" };
const GROUP_NAME: Record<AgentPresetId, string> = { assistant: "Raer", planner: "Tonny", builder: "Bob" };
const menuItem = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", border: 0, borderRadius: 8,
  background: "transparent", cursor: "pointer", fontSize: 14, textAlign: "left" } as const;

/** Grok-style "+": pick who to talk to — one agent opens a chat with it, two or more make a group. */
export function NewChatMenu({ avatars, onNewGroup, onSelectAgent }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  onNewGroup: (members: AgentPresetId[]) => void;
  onSelectAgent: (id: AgentPresetId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AgentPresetId[]>([]);
  const ordered = AGENT_PRESETS.map((p) => p.id).filter((id) => picked.includes(id));
  const toggle = (id: AgentPresetId) => setPicked((current) => current.includes(id) ? current.filter((m) => m !== id) : [...current, id]);
  const start = () => {
    if (ordered.length === 1) onSelectAgent(ordered[0]);
    else if (ordered.length > 1) onNewGroup(ordered);
    setOpen(false);
    setPicked([]);
  };
  return (
    <RadixPopover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPicked([]); }}>
      <RadixPopover.Trigger asChild>
        <button type="button" className="rail-icon-btn" aria-label="新建对话" title="新建对话或 Group">
          <span style={{ fontSize: 18, lineHeight: 1 }}>＋</span>
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align="start" sideOffset={6} style={{ zIndex: 50, width: 260, padding: 6, borderRadius: 12,
          background: "var(--surface, #fff)", boxShadow: "0 8px 30px rgba(15,23,42,.14)", border: "1px solid rgba(15,23,42,.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 34, padding: "4px 10px 8px",
            borderBottom: "1px solid rgba(15,23,42,.08)", marginBottom: 4, fontSize: 14 }}>
            <span style={{ opacity: 0.55 }}>To:</span>
            {ordered.length ? ordered.map((id) => (
              <span key={id} style={{ ...chip(true), padding: "2px 8px 2px 2px", cursor: "default" }}><AgentAvatar size={18} kind={avatars[id]} />{GROUP_NAME[id]}</span>
            )) : <span style={{ opacity: 0.4 }}>选择一位或多位成员</span>}
          </div>
          {AGENT_PRESETS.map((preset) => {
            const on = picked.includes(preset.id);
            return (
              <button type="button" key={preset.id} style={{ ...menuItem, background: on ? "rgba(59,91,219,.08)" : "transparent" }}
                aria-pressed={on} onClick={() => toggle(preset.id)}>
                <AgentAvatar size={24} kind={avatars[preset.id]} />
                <span>{GROUP_NAME[preset.id]}</span>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.55 }}>{GROUP_ROLE[preset.id]}</span>
                <span aria-hidden="true" style={{ width: 16, textAlign: "center", color: "#3b5bdb", fontWeight: 700 }}>{on ? "✓" : ""}</span>
              </button>
            );
          })}
          <button type="button" disabled={!ordered.length} onClick={start}
            style={{ ...menuItem, justifyContent: "center", marginTop: 6, fontWeight: 600, color: ordered.length ? "#fff" : "inherit",
              background: ordered.length ? "#3b5bdb" : "rgba(15,23,42,.06)", opacity: ordered.length ? 1 : 0.5, cursor: ordered.length ? "pointer" : "default" }}>
            {ordered.length === 0 ? "选择成员" : ordered.length === 1 ? `和 ${GROUP_NAME[ordered[0]]} 聊` : `创建 Group（${ordered.map((id) => GROUP_NAME[id]).join("、")}）`}
          </button>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

const chip = (on: boolean) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 4px", borderRadius: 999,
  border: `1px solid ${on ? "rgba(59,91,219,.35)" : "rgba(15,23,42,.12)"}`, background: on ? "rgba(59,91,219,.08)" : "transparent",
  opacity: on ? 1 : 0.55, cursor: "pointer", fontSize: 13 }) as const;

/**
 * The group's top bar. Before the first message it is a "To:" picker; afterwards the group's face and
 * names, which open a member panel (roles, engines, add/remove for the next message).
 */
export function GroupHeader({ avatars, members, draft, onChange }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  members: readonly AgentPresetId[];
  draft: boolean;
  onChange: (members: AgentPresetId[]) => void;
}) {
  const toggle = (id: AgentPresetId) => {
    const next = members.includes(id) ? members.filter((m) => m !== id) : AGENT_PRESETS.map((p) => p.id).filter((m) => m === id || members.includes(m));
    if (next.length) onChange(next);
  };
  const names = ["我", ...members.map((m) => GROUP_NAME[m])].join("、");
  if (draft) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, opacity: 0.6 }}>To:</span>
        {AGENT_PRESETS.map((preset) => (
          <button key={preset.id} type="button" style={chip(members.includes(preset.id))} aria-pressed={members.includes(preset.id)} onClick={() => toggle(preset.id)}>
            <AgentAvatar size={20} kind={avatars[preset.id]} />{GROUP_NAME[preset.id]}
          </button>
        ))}
      </div>
    );
  }
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        <button type="button" style={{ display: "flex", alignItems: "center", gap: 10, border: 0, background: "transparent", cursor: "pointer", padding: 0 }}>
          <GroupFace size={34} kinds={members.map((m) => avatars[m])} />
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.25 }}>
            <strong style={{ fontSize: 16 }}>{names}</strong>
            <span style={{ fontSize: 12, opacity: 0.6 }}>Group · {members.length + 1} 位成员</span>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align="start" sideOffset={8} style={{ zIndex: 50, width: 280, padding: 10, borderRadius: 12,
          background: "var(--surface, #fff)", boxShadow: "0 8px 30px rgba(15,23,42,.14)", border: "1px solid rgba(15,23,42,.08)" }}>
          <div style={{ fontSize: 12, opacity: 0.6, padding: "2px 4px 8px" }}>成员（改动从下一条消息生效）</div>
          <div style={{ ...menuItem, cursor: "default" }}>
            <GroupFace size={24} kinds={[]} /><span>我</span><span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.55 }}>你</span>
          </div>
          {AGENT_PRESETS.map((preset) => {
            const on = members.includes(preset.id);
            return (
              <button key={preset.id} type="button" style={{ ...menuItem, opacity: on ? 1 : 0.5 }} onClick={() => toggle(preset.id)}>
                <AgentAvatar size={24} kind={avatars[preset.id]} />
                <span>{GROUP_NAME[preset.id]} · {GROUP_ROLE[preset.id]}</span>
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.7 }}>
                  <HarnessMark harness={preset.harness} />{on ? "在群里" : "已移出"}
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
export function GroupWelcome({ avatars, members, onChange }: {
  avatars: Record<AgentPresetId, AvatarKind>;
  members: readonly AgentPresetId[];
  onChange: (members: AgentPresetId[]) => void;
}) {
  return (
    <div className="composer-greeting" style={{ flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
      <span aria-hidden="true"><GroupFace size={76} kinds={members.map((m) => avatars[m])} /></span>
      <h2 className="composer-greeting-text" style={{ margin: 0 }}>{["我", ...members.map((m) => GROUP_NAME[m])].join("、")}</h2>
      <p style={{ margin: 0, opacity: 0.6, fontSize: 14 }}>新的 Group：选好成员，发第一条消息就开始。说声 hello，大家会各自打个招呼。</p>
      <GroupHeader avatars={avatars} members={members} draft onChange={onChange} />
    </div>
  );
}
