import type { AgentUXTimelineItem, AgentUXToolTimelineItem, AgentUXViewModel } from "@agent-ux/render-core";
import { AgentAvatar, AgentPersonaProvider, avatarBusy, useAgentPersona, type AvatarKind } from "../../avatars/AgentPersona";

// Group chat: member items carry ids tagged "<role>~…" (see src/pi/groupChat.ts).
const GROUP_AUTHORS: Record<string, { kind: AvatarKind; name: string }> = {
  assistant: { kind: "woman", name: "Raer" }, planner: { kind: "man", name: "Tonny" }, builder: { kind: "boy", name: "Bob" },
};
// Tool and artifact ids are wrapped as JSON [runId, field, id] by replayIdentity, so match inside too.
const itemAuthor = (item: AgentUXTimelineItem) => /(?:^|")(assistant|planner|builder)~/.exec(String(item.id))?.[1];
import { useShellExtras } from "../shell/ShellExtras";
import { cloneElement, type ReactElement } from "react";
import { useTranscriptScroll } from "../../runtime/useTranscriptScroll";

import { StateIcon, errorDomainSlot, incidentSlot, runtimeOpSlot, useIconSet, type IconSlot } from "../../agentmatrix";
import { useCopy } from "../../i18n/LocaleContext";
import { ShimmerText } from "../ShimmerText";
import type { UiCopy } from "../../i18n/uiCopy";
import type { AgentFrontendProject } from "../../schema/agentuxConfig";
import { ArtifactLaunchCard } from "./chatframe/ArtifactLaunch";
import { ExternalApprovalSurface, isPendingApprovalTool } from "./chatframe/approval";
import { MessageActions } from "./chatframe/MessageActions";
import type { OutputPanelOpenRequest } from "./OutputFrame";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCallCard, type ApprovalDecision } from "./ToolCallCard";
import { WritingText } from "./WritingText";

// The approval surfaces stay re-exported from this module: both the editor and the generated
// agent-shell import them from "./components/agent-preview/ChatFrame", and the scaffold export
// asserts on that path.
export { InlineApprovalPrompt, InlineApprovalSurface, ExternalApprovalSurface } from "./chatframe/approval";
export type { InlineApprovalPromptOption } from "./chatframe/approval";

export function ChatFrame({
  project,
  viewModel,
  showDebugBadges = false,
  previewPrompt = "Add validation to the search input and show a loading state while results are fetched.",
  previewPrompts,
  writingReplayKey = 0,
  onOpenArtifact,
  // Defaults to the placement the editor previews. It used to default to "timeline", which
  // only the editor was safe from because `App.tsx` passes "overlay" explicitly: the exported
  // app never set the prop, so a real run there put the permission card *inside* the
  // transcript, where it scrolls away from the field the user answers it with. Nothing asks
  // for the timeline placement, so the fallback is now the correct one and it stays opt-in.
  externalApprovalPlacement = "overlay",
  forceToolsOpen = false,
  toolCollapseSignal = 0,
  onApprovalDecision,
}: {
  project: AgentFrontendProject;
  viewModel: AgentUXViewModel;
  showDebugBadges?: boolean;
  previewPrompt?: string;
  previewPrompts?: readonly string[];
  writingReplayKey?: number;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
  externalApprovalPlacement?: "timeline" | "overlay";
  forceToolsOpen?: boolean;
  toolCollapseSignal?: number;
  onApprovalDecision?: (toolCallId: string, decision: ApprovalDecision) => void | Promise<void>;
}) {
  const copy = useCopy();
  const promptHistory = previewPrompts?.filter((prompt) => prompt.trim().length > 0);

  const { headerAgent, transcriptScroll, transcriptTarget, groupTyping } = useShellExtras();
  const listRef = useTranscriptScroll(viewModel.timeline, transcriptScroll, transcriptTarget);
  return (
    <section
      className="chat-frame"
      data-preview-anchor="chat"
      data-reasoning-motion={project.theme.motion.reasoning}
      data-tool-style={project.theme.motion.toolCall}
      data-writing-motion={project.theme.motion.writing}
    >
      <header className="frame-header">
        {headerAgent ?? (
          <div>
            <h2>{copy.chat.frame.title}</h2>
            <p>{viewModel.title ?? copy.chat.frame.fallbackConversationTitle} · {copy.chat.frame.subtitleSuffix}</p>
          </div>
        )}
      </header>
      <div className="timeline-list" ref={listRef}>
        {viewModel.timeline.length === 0 ? (
          <ConversationEmptyState project={project} />
        ) : (
          renderConversation(
            buildConversationEntries(viewModel.timeline, promptHistory, previewPrompt),
            project,
            showDebugBadges,
            writingReplayKey,
            onOpenArtifact,
            externalApprovalPlacement,
            forceToolsOpen,
            toolCollapseSignal,
            onApprovalDecision,
          )
        )}
        {groupTyping ? <GroupTypingRow member={groupTyping} /> : null}
      </div>
    </section>
  );
}

type ConversationEntry =
  | { kind: "user"; id: string; prompt: string }
  | { kind: "item"; item: AgentUXTimelineItem };

/**
 * Flatten the timeline into an ordered list of user prompts and assistant-side
 * items. When prompt history is available each assistant message is preceded by
 * the prompt that produced it; otherwise the single preview prompt opens the run.
 */
function buildConversationEntries(
  timeline: readonly AgentUXTimelineItem[],
  promptHistory: readonly string[] | undefined,
  previewPrompt: string,
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  if (promptHistory?.length) {
    let assistantMessageIndex = 0;
    for (const item of timeline) {
      if (item.kind === "message" && item.role === "assistant") {
        const prompt = promptHistory[assistantMessageIndex];
        assistantMessageIndex += 1;
        if (prompt) {
          entries.push({ kind: "user", id: `prompt:${item.id}`, prompt });
        }
      }
      entries.push({ kind: "item", item });
    }
    return entries;
  }

  if (previewPrompt.trim()) {
    entries.push({ kind: "user", id: "preview-prompt", prompt: previewPrompt });
  }
  for (const item of timeline) {
    entries.push({ kind: "item", item });
  }
  return entries;
}

/**
 * Group consecutive assistant-side items into a single turn that shares one
 * avatar lane. A user message breaks the current turn and renders as its own row.
 */
function renderConversation(
  entries: ConversationEntry[],
  project: AgentFrontendProject,
  showDebugBadges: boolean,
  writingReplayKey: number,
  onOpenArtifact: ((artifact: OutputPanelOpenRequest) => void) | undefined,
  externalApprovalPlacement: "timeline" | "overlay",
  forceToolsOpen: boolean,
  toolCollapseSignal: number,
  onApprovalDecision: ((toolCallId: string, decision: ApprovalDecision) => void | Promise<void>) | undefined,
): ReactElement[] {
  const rows: ReactElement[] = [];
  let lane: AgentUXTimelineItem[] = [];
  const groupMode = entries.some((entry) => entry.kind === "item" && Boolean(itemAuthor(entry.item)));
  let laneAuthor: string | undefined;
  let turnIndex = 0;
  let latestTurnRow = -1;
  /** Group chat: each member's newest answer, whose face stays present (calmly alive). */
  const latestByMember = new Map<string, number>();

  const flushLane = () => {
    if (lane.length === 0) {
      return;
    }
    const laneItems = lane;
    const author = laneAuthor;
    lane = [];
    latestTurnRow = rows.length;
    if (groupMode && author && GROUP_AUTHORS[author]) latestByMember.set(author, rows.length);
    rows.push(
      <AssistantTurn
        key={`turn:${turnIndex}`}
        project={project}
        items={laneItems}
        showDebugBadges={showDebugBadges}
        writingReplayKey={writingReplayKey}
        onOpenArtifact={onOpenArtifact}
        externalApprovalPlacement={externalApprovalPlacement}
        forceToolsOpen={forceToolsOpen}
        toolCollapseSignal={toolCollapseSignal}
        onApprovalDecision={onApprovalDecision}
        groupAuthor={groupMode ? author ?? "coordinator" : undefined}
      />,
    );
    turnIndex += 1;
  };

  for (const entry of entries) {
    if (entry.kind === "user") {
      flushLane();
      rows.push(<UserPromptBubble key={entry.id} project={project} prompt={entry.prompt} />);
      continue;
    }
    if (entry.item.kind === "message" && entry.item.role === "user") {
      flushLane();
      rows.push(<UserPromptBubble key={`msg:${entry.item.id}`} project={project} prompt={entry.item.text || ""} messageId={entry.item.id} />);
      continue;
    }
    const author = itemAuthor(entry.item);
    if (groupMode && lane.length && author !== laneAuthor) flushLane();
    laneAuthor = author;
    lane.push(entry.item);
  }
  flushLane();

  // Only the newest answer's avatar is alive; older ones stay still drawings. In a group, every
  // member's newest answer also keeps a calm face, so the others still look present.
  if (latestTurnRow >= 0) rows[latestTurnRow] = cloneElement(rows[latestTurnRow] as ReactElement<{ live?: boolean }>, { live: true });
  for (const row of latestByMember.values()) {
    if (row !== latestTurnRow) rows[row] = cloneElement(rows[row] as ReactElement<{ present?: boolean }>, { present: true });
  }
  return rows;
}

/** Group chat: the member who is working but has not said anything yet — face and "thinking", nothing else. */
function GroupTypingRow({ member }: { member: string }) {
  const outer = useAgentPersona();
  const face = GROUP_AUTHORS[member];
  if (!face) return null;
  const persona = { ...(outer ?? { state: "thinking" as const }), ...face, state: "thinking" as const };
  return (
    <AgentPersonaProvider persona={persona}>
      <div className="assistant-turn" data-group-typing={member}>
        <span className="msg-avatar" data-role="assistant" data-persona="true" aria-hidden="true">
          <AgentAvatar size={32} live />
        </span>
        <div className="assistant-lane">
          <div className="assistant-turn-label">{face.name}</div>
          <ShimmerText className="reasoning-title" text="正在思考…" />
        </div>
      </div>
    </AgentPersonaProvider>
  );
}

function AssistantTurn({
  project,
  items,
  showDebugBadges,
  writingReplayKey,
  onOpenArtifact,
  externalApprovalPlacement,
  forceToolsOpen,
  toolCollapseSignal,
  onApprovalDecision,
  live = false,
  present = false,
  groupAuthor,
}: {
  groupAuthor?: string;
  /** Group chat: this member's newest answer, not the newest overall; its face idles calmly. */
  present?: boolean;
  project: AgentFrontendProject;
  items: readonly AgentUXTimelineItem[];
  showDebugBadges: boolean;
  writingReplayKey: number;
  live?: boolean;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
  externalApprovalPlacement: "timeline" | "overlay";
  forceToolsOpen: boolean;
  toolCollapseSignal: number;
  onApprovalDecision?: (toolCallId: string, decision: ApprovalDecision) => void | Promise<void>;
}) {
  const outer = useAgentPersona();
  if (groupAuthor && outer) {
    const member = GROUP_AUTHORS[groupAuthor];
    const persona = member ? { ...outer, ...member, state: live ? outer.state : "idle" as const }
      : { ...outer, name: "群聊编排", kind: undefined as unknown as AvatarKind };
    return (
      <AgentPersonaProvider persona={persona}>
        <AssistantTurnBody {...{ project, items, showDebugBadges, writingReplayKey, onOpenArtifact, externalApprovalPlacement,
          forceToolsOpen, toolCollapseSignal, onApprovalDecision, live }} present={present && !live} forceLabel hideAvatar={!member} />
      </AgentPersonaProvider>
    );
  }
  return <AssistantTurnBody {...{ project, items, showDebugBadges, writingReplayKey, onOpenArtifact, externalApprovalPlacement,
    forceToolsOpen, toolCollapseSignal, onApprovalDecision, live }} />;
}

function AssistantTurnBody({
  project, items, showDebugBadges, writingReplayKey, onOpenArtifact, externalApprovalPlacement,
  forceToolsOpen, toolCollapseSignal, onApprovalDecision, live = false, present = false, forceLabel = false, hideAvatar = false,
}: {
  hideAvatar?: boolean;
  present?: boolean;
  project: AgentFrontendProject;
  items: readonly AgentUXTimelineItem[];
  showDebugBadges: boolean;
  writingReplayKey: number;
  live?: boolean;
  forceLabel?: boolean;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
  externalApprovalPlacement: "timeline" | "overlay";
  forceToolsOpen: boolean;
  toolCollapseSignal: number;
  onApprovalDecision?: (toolCallId: string, decision: ApprovalDecision) => void | Promise<void>;
}) {
  const copy = useCopy();
  const persona = useAgentPersona();
  const orderedItems = displayOrderForAssistantTurn(items);
  const isSingleLineAssistantMessage =
    !project.conversation.speakerLabels
    && orderedItems.length === 1
    && orderedItems[0]?.kind === "message"
    && orderedItems[0].role === "assistant"
    && !orderedItems[0].text?.includes("\n");

  return (
    <div className="assistant-turn" data-single-line-message={isSingleLineAssistantMessage ? "true" : undefined}>
      {project.conversation.agentAvatar && !hideAvatar ? (
        <span className="msg-avatar" data-role="assistant" data-persona={persona ? "true" : undefined} aria-hidden="true">
          <AgentAvatar size={32} live={live || present} calm={present} fallback={<StateIcon slot="author.agent" size={15} />} />
        </span>
      ) : null}
      <div className="assistant-lane">
        {project.conversation.speakerLabels || forceLabel ? (
          <div className="assistant-turn-label" aria-label={copy.chat.speakers.agentOutputLabel}>{persona?.name ?? copy.chat.speakers.agent}</div>
        ) : null}
        {orderedItems.map((item) => (
          <TimelineItem
            key={`${item.kind}:${item.id}`}
            item={item}
            project={project}
            showDebugBadges={showDebugBadges}
            writingReplayKey={writingReplayKey}
            onOpenArtifact={onOpenArtifact}
            externalApprovalPlacement={externalApprovalPlacement}
            forceToolsOpen={forceToolsOpen}
            toolCollapseSignal={toolCollapseSignal}
            onApprovalDecision={onApprovalDecision}
          />
        ))}
      </div>
    </div>
  );
}

function displayOrderForAssistantTurn(items: readonly AgentUXTimelineItem[]): AgentUXTimelineItem[] {
  const ordered: AgentUXTimelineItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    const next = items[index + 1];
    if (current?.kind === "artifact" && next?.kind === "message" && next.role === "assistant") {
      ordered.push(next, current);
      index += 1;
      continue;
    }
    ordered.push(current);
  }
  return ordered;
}

function UserPromptBubble({ project, prompt, messageId }: { project: AgentFrontendProject; prompt: string; messageId?: string }) {
  const copy = useCopy();
  return (
    <article className="message-item message-bubble" data-role="user" data-preview-anchor="conversation" data-message-id={messageId}>
      {project.conversation.userAvatar ? (
        <span className="msg-avatar" data-role="user" aria-hidden="true"><StateIcon slot="author.user" size={16} /></span>
      ) : null}
      <div className="msg-stack">
        {project.conversation.speakerLabels ? <div className="message-role">{copy.chat.speakers.user}</div> : null}
        <div className="msg-surface"><p>{prompt}</p></div>
        <MessageActions project={project} role="user" text={prompt} messageId={messageId} />
      </div>
    </article>
  );
}

function TimelineItem({
  item,
  project,
  showDebugBadges,
  writingReplayKey,
  onOpenArtifact,
  externalApprovalPlacement,
  forceToolsOpen,
  toolCollapseSignal,
  onApprovalDecision,
}: {
  item: AgentUXTimelineItem;
  project: AgentFrontendProject;
  showDebugBadges: boolean;
  writingReplayKey: number;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
  externalApprovalPlacement: "timeline" | "overlay";
  forceToolsOpen: boolean;
  toolCollapseSignal: number;
  onApprovalDecision?: (toolCallId: string, decision: ApprovalDecision) => void | Promise<void>;
}) {
  const copy = useCopy();
  const { iconSet } = useIconSet();
  const persona = useAgentPersona();
  switch (item.kind) {
    case "message": {
      const isAssistant = item.role === "assistant";
      // History (opened or restored) shows at once; an answer that appears during a run types out,
      // even when a short one is already finished by the time it reaches the screen.
      const settled = item.status === "done" && !(persona && avatarBusy(persona.state));
      const text = item.text || copy.chat.message.streaming;
      return (
        <article className="message-bubble lane-message" data-role={item.role} data-message-id={item.id}>
          {project.conversation.speakerLabels ? <div className="message-role">{messageRoleLabel(item.role, copy)}</div> : null}
          <div className="msg-surface">
            {isAssistant ? (
              <WritingText project={project} text={text} replayKey={writingReplayKey} settled={settled} />
            ) : <p>{text}</p>}
          </div>
          <MessageActions project={project} role={isAssistant ? "assistant" : "user"} text={item.text ?? ""} messageId={item.id} />
        </article>
      );
    }
    case "reasoning":
      return <ReasoningBlock project={project} reasoning={item} showDebugBadges={showDebugBadges} />;
    case "tool":
      if (isMediaGenerationTool(item)) {
        return null;
      }
      return (
        <>
          {project.toolCalls.approval === "hidden" && externalApprovalPlacement === "timeline" && isPendingApprovalTool(item) ? (
            <ExternalApprovalSurface
              tool={item}
              onConfirm={(decision) => onApprovalDecision?.(item.id, decision)}
            />
          ) : null}
          <ToolCallCard
            project={project}
            tool={item}
            showDebugBadges={showDebugBadges}
            onOpenArtifact={onOpenArtifact}
            forceOpen={forceToolsOpen}
            collapseSignal={toolCollapseSignal}
          />
        </>
      );
    case "artifact":
      return <ArtifactLaunchCard project={project} item={item} copy={copy} onOpenArtifact={onOpenArtifact} />;
    case "step": {
      const kind = item.stepKind ?? item.scope?.kind ?? "runtime";
      const spin = item.status === "running" || item.status === "started";
      return (
        <article className="step-item" data-status={item.status}>
          <span className="step-icon" data-anim={spin ? "spin" : "none"}>
            <StateIcon slot={stepIconSlot(kind, item.status)} size={14} />
          </span>
          <span className="step-kind">{kind}</span>
          <strong>{item.label}</strong>
          {item.summary ? <p>{item.summary}</p> : null}
        </article>
      );
    }
    case "error": {
      // Incident states (retrying / exhausted / terminal) show a readable,
      // state-matching title instead of the raw error code.
      const incidentTitle =
        item.code === "history_load_failed"
          ? copy.workspace.sessionSidebar.historyTitle
          : item.category === "retrying"
          ? copy.chat.error.incident.retrying
          : item.category === "exhausted"
            ? copy.chat.error.incident.exhausted
            : item.category === "terminal"
              ? copy.chat.error.incident.terminal
              : item.code;
      return (
        <article className="error-item" data-collapse={project.blocks.errorCollapse} data-preview-anchor="error-block">
          <span className="error-icon" data-anim={errorIconAnimation(item.category, item.retryable, iconSet["incident.retrying"])}>
            <StateIcon slot={errorIconSlot(item.category, item.code)} size={15} />
          </span>
          <strong>{incidentTitle}</strong>
          <p>{project.blocks.errorCollapse ? item.userMessage ?? item.message : item.developerMessage ?? item.message}</p>
          {project.blocks.errorCollapse ? <small>{copy.chat.error.debugHidden}</small> : null}
        </article>
      );
    }
  }
}

function errorIconSlot(category: string | undefined, code: string): IconSlot {
  if (category === "retrying" || category === "exhausted" || category === "terminal") {
    return incidentSlot(category);
  }
  return errorDomainSlot(code);
}

function errorIconAnimation(category: string | undefined, retryable: boolean | undefined, retryingIconId: string | undefined) {
  if (category === "retrying") {
    if (retryingIconId === "timer") return "timer-hand";
    if (retryingIconId === "rotate") return "retry-rotate";
    if (retryingIconId === "hourglass") return "hourglass";
  }
  return retryable ? "spin" : "none";
}

function stepIconSlot(kind: string, status: string): IconSlot {
  if (kind === "model") return "surface.model_span";
  if (kind === "config") return "surface.config";
  if (kind === "session") return "surface.interrupt";
  return runtimeOpSlot(status);
}

function messageRoleLabel(role: string, copy: UiCopy): string {
  if (role === "assistant") {
    return copy.chat.speakers.agent;
  }
  if (role === "user") {
    return copy.chat.speakers.user;
  }
  return role;
}

function isMediaGenerationTool(item: AgentUXToolTimelineItem): boolean {
  return item.name.startsWith("preview.generate_");
}

function ConversationEmptyState({ project }: { project: AgentFrontendProject }) {
  const copy = useCopy();
  if (project.conversation.emptyState === "suggested-prompts") {
    return (
      <div className="empty-state starter-prompts">
        <button type="button">{copy.chat.emptyState.suggestedPrompts.inspectContext}</button>
        <button type="button">{copy.chat.emptyState.suggestedPrompts.draftResponse}</button>
        <button type="button">{copy.chat.emptyState.suggestedPrompts.summarizeWork}</button>
      </div>
    );
  }

  if (project.conversation.emptyState === "capability-hints") {
    return (
      <div className="empty-state capability-hints">
        <span>{copy.chat.emptyState.capabilityHints.files}</span>
        <span>{copy.chat.emptyState.capabilityHints.tools}</span>
        <span>{copy.chat.emptyState.capabilityHints.output}</span>
      </div>
    );
  }

  return <div className="empty-state">{copy.chat.emptyState.noEvents}</div>;
}
