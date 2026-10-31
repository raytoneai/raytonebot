import { featureText, featureError, groupRosterTitle } from "./i18n/copy/features.ts";
import { useLearning } from "./runtime/useLearning";
import { useVault } from "./runtime/useVault";
import { useTaskRecovery } from "./runtime/useTaskRecovery";
import { useAppViewport } from "./runtime/useAppViewport";
import { useOutputPanel } from "./runtime/useOutputPanel";
import { useCompactDrawer } from "./runtime/useCompactDrawer";
import { useAutoHiddenRails } from "./runtime/useAutoHiddenRails";
import { artifactTimestamps } from "./runtime/artifactCatalog";
import { outputPanelItemFromRenderedArtifact } from "./components/agent-preview/outputframe/artifactPreview";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createAgentUXViewModel, type AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { PanelLeft, PanelRight } from "lucide-react";

import {
  normalizeOutputPanelRequest,
  type OutputPanelItem,
  type OutputPanelOpenRequest,
} from "./components/agent-preview/outputframe/panelItem";
import { useBotProfiles, bindBotConversation, forgetBotConversation, saveBotProfile, syncBotProfiles } from "./runtime/useBotProfiles";
import { BOT_NAMES, botModelConfiguration, conversationBotId, type BotProfile } from "./runtime/botProfiles";
import { DEFAULT_NEW_BOT } from "./runtime/botAppearance";
import type { BotEditorState } from "./components/shell/BotEditor";
import type { SettingsSectionId } from "./components/settings/SettingsDialog";
import { AgentSwitcher, GroupHeader, GroupWelcome, NewChatMenu, HeaderAgent, ShellExtrasProvider, SidebarFooter, type AgentRunStatus, type ShellExtras } from "./components/shell/ShellExtras";
import { settingsCopy } from "./i18n/copy/settings";
import type { ComposerDraft, ComposerRunOptions, ComposerSubmitContext } from "./components/agent-preview/ComposerFrame";
import { ExternalApprovalSurface, InlineApprovalSurface } from "./components/agent-preview/ChatFrame";
import type { ApprovalDecision } from "./components/agent-preview/ToolCallCard";
import { RightSidebarRailIcon, SidebarRailIcon } from "./components/common/RailIcons";
import { SelectMenu } from "./components/ui/select-menu";
import { gitPreviewStateFromEvents } from "./harness/gitAdapter";
import { useCopy, useLocale } from "./i18n/LocaleContext";
import { localizePreviewViewModel } from "./i18n/previewLocalization";
import { createReasoningRenderPolicy } from "./preview/reasoningPreviewPolicy";
import {
  defaultProviderConnection,
  modelOptionsForProject,
  type ProviderConnection,
  type ProviderConnectionId,
  type SlotConfig,
} from "./schema/agentuxConfig";
import { renderSlots, slotsForTemplate, type SlotRenderContext } from "./slots/slotRegistry";
import { applyTheme, themeVariables } from "./theme/applyTheme";
import { artifactThemeCss } from "./components/agent-preview/outputframe/artifactTheme";
import { resolveThemePreset, themeTokens, type ThemePresetId } from "./theme/themeTokens";
import { isFixtureMode, useEventSource } from "./event-source";
import { project } from "./exported-project";
import {
  steerPiTurn,
  checkPiAttachment,
  configurePiRuntime,
  getPiRuntimeState,
  getBrowserState,
  getStoredConversation,
  getStoredConversationSummary,
  deleteStoredConversation,
  renameStoredConversation,
  followPiTurn,
  listStoredConversations,
  searchStoredConversations,
  submitPiApproval,
  runPiTurn, runGroupTurn, updateGroupMembers,
  uploadPiFile,
  startNewPiSession,
  PiRequestError,
  type PiFileReference,
  type PiPromptAttachment,
  type PiRuntimeState,
  type StoredConversationSummary,
} from "./pi/piClient";
import { piRuntimeConfigurationForProvider } from "./pi/piProviderSync";
import { isGroupConversation } from "./pi/piConversationState";
import { validParticipantId } from "./pi/groupParticipants";
import { isAgentPresetId, loadAgentSettings, saveAgentSettings, settingsUseProvider, type AgentPresetId, type AgentSettings } from "./pi/harnessCatalog";
import { CustomAvatarsProvider, AgentPersonaProvider, type AgentPersona, type AvatarKind } from "./avatars/AgentPersona";
import type { TranscriptScroll } from "./runtime/useTranscriptScroll";
import { InlineApprovalPrompt } from "./components/agent-preview/chatframe/approval";
import { pendingUserInput, userInputEventsForReplay } from "./runtime/userInput";
import { useUserInput } from "./runtime/useUserInput";
import { pendingChannelSetup } from "./runtime/channelSetup";
import { useChannelSetup } from "./runtime/useChannelSetup";
import { pendingVaultRequest } from "./runtime/vaultRequest";
import { useVaultRequest } from "./runtime/useVaultRequest";
import { finishedHtmlEdits } from "./runtime/liveHtmlWrite";
import { approvalRequestKey } from "./runtime/approvalSubmission";
import { approvalForReplay, identityEventForReplay } from "./runtime/replayIdentity";
import { questionCopy } from "./i18n/copy/questions";
import { useRunStop } from "./runtime/runStop";
import { useProviderSettings } from "./runtime/useProviderSettings";
import { useImChannels } from "./runtime/useImChannels";
import { useRoutines } from "./runtime/useRoutines";
import { useMcpServers } from "./runtime/useMcpServers";
import { useMemories } from "./runtime/useMemories";
import { useSkills } from "./runtime/useSkills";
import { useUsage } from "./runtime/useUsage";
import { conversationHistoryGroup, useSessionHistoryGroups } from "./runtime/useSessionHistoryGroups";
import { groupConversationFaces, groupConversationPreviews, groupConversationTitle, groupFields, groupMembersOf } from "./runtime/groupConversationView";

const THEME_KEY = "raytonebot.theme";
/** Events after which a tool call is no longer waiting on the user. */
const APPROVAL_SETTLED_EVENTS = new Set(["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished", "run.finished"]);
const PERMISSION_DEFAULT_KEY = "raytonebot.permissionDefault";

// Rejected requests also synthesize run.started + user text, so those are not acceptance.
// Any terminal other than a rejection means the host saved the prompt in the conversation.
// The adapter's user text.finished is broadcast only after the recorder flushed the prompt, so it
// clears the draft before a slow CLI's first output; a rejection's synthesized one is `<runId>_user_finished`.
const confirmsPromptAccepted = (event: AgentUXEvent) => event.type.startsWith("tool.call.")
  || (event.type === "text.finished" && event.id?.includes("_user_text_finished_"))
  || event.type.startsWith("reasoning.")
  || (event.type === "text.started" && (event.payload as { role?: string }).role === "assistant")
  || event.type === "run.finished"
  || (event.type === "run.error" && (event.payload as { code?: string }).code !== PROMPT_REJECTED);

function readSetting(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeSetting(key: string, value: string | undefined) {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice still applies until reload.
  }
}

/** Each preset role has its own face (characters from the Raytone avatar study). */
const PRESET_AVATARS: Record<AgentPresetId, AvatarKind> = {
  assistant: "woman",
  planner: "man",
  builder: "boy",
  dsh: "woman",
};
import {
  appendPiConversationEvents,
  createEphemeralPiConversation,
  piConversationSidebarItems,
  replacePiConversation,
  titlePiConversation,
  type EphemeralPiConversation,
} from "./pi/piConversationState";
import { piErrorTurnEvents, PROMPT_REJECTED } from "./pi/piErrorTurn";
import { workspaceFileUrl } from "./runtime/filePreview";
import { artifactAuthor, artifactEventForReplay, refreshArtifactItems } from "./runtime/artifactContent";
import { displayTaskPlans } from "./runtime/taskPlan";
import { historyFeedbackEvents, type HistoryNotice } from "./runtime/historyFeedback";
import { hasComposerDraft, hasComposerState } from "./runtime/composerDraftStore";
import { avatarActivity, runOutcomeFace, workingGroupMember, type RunOutcomeFace } from "./runtime/avatarActivity";
import type { AvatarState } from "./avatars/avatarMotion";
import { composerActivityCopy } from "./i18n/copy/composerActivity";
import { GroupFace } from "./avatars/GroupFace";
import { lastRunOutcome, nextQueueStep, queuedPrompt, type QueuedMessage } from "./runtime/followUpQueue";
import { useComposerDrafts } from "./runtime/useComposerDrafts";
import { branchReplayEvents, useMessageBranch } from "./runtime/useMessageBranch";
import { piCancelledTurnEvents } from "./pi/piCancelledTurn";
import { createPiFrameCommit } from "./pi/piFrameCommit";

const noop = () => {};

/** Back off after a dropped connection; an acknowledged stop cancels the wait immediately. */
function waitForReconnect(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

// Loaded on first use, not with the app: settings, the full-screen output view and the resizable
// output panel are closed when a conversation opens.
const SettingsDialog = lazy(() => import("./components/settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const OutputPanelModal = lazy(() => import("./components/agent-preview/outputframe/OutputPanelModal").then((module) => ({ default: module.OutputPanelModal })));
const OutputFrame = lazy(() => import("./components/agent-preview/OutputFrame").then((module) => ({ default: module.OutputFrame })));
const RightPanelLayout = lazy(() => import("./components/shell/RightPanelLayout").then((module) => ({ default: module.RightPanelLayout })));

/** Development fixtures are useful, but their controls are not part of the composed product. */
function devtoolsRequested(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("devtools");
  return value === "1" || value === "true";
}

/**
 * The exported agent surface.
 *
 * This renders through the SAME `slots/slotRegistry` the AgentCanvas configurator uses,
 * with the same `data-*` attributes on `.preview-frame` (App.tsx:2902-2911) and the same
 * render policy derived from the project (App.tsx:1210-1221). Anything visual is decided
 * by the real components + `styles/app.css`, not re-implemented here — that is what keeps
 * the export from drifting away from what you previewed.
 *
 * Pi is mounted by the generated Vite config, so submit, stop, provider/model selection and
 * tool approvals are live while the same fixture path remains available for visual QA.
 */
export function AgentApp() {
  useAppViewport();
  const { locale } = useLocale();
  const copy = useCopy();
  const frameRef = useRef<HTMLDivElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Visual-only control beside the existing event fixtures; never drives a real run.
  const [activityPreview, setActivityPreview] = useState<AvatarState | "">("");
  /** Phones: the sidebar (agents, history, settings) lives in a drawer opened from the top left. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const outputPanel = useOutputPanel(project.output.source);
  const { rightCollapsed, setRightCollapsed } = outputPanel;
  const [sessionKeys, setSessionKeys] = useState<Record<string, string>>({});
  const [providerSelectionError, setProviderSelectionError] = useState<string>();
  const providerSelectionPending = useRef(false);
  const { project: configuredProject, setProject: setConfiguredProject, status: providerSettingsStatus, saveProviders, saved: savedProviderSettings } = useProviderSettings(project);
  const [piEvents, setPiEvents] = useState<AgentUXEvent[] | undefined>(undefined);
  const [piConversations, setPiConversations] = useState<readonly EphemeralPiConversation[]>(() => [
    createEphemeralPiConversation(),
  ]);
  const [activePiConversationId, setActivePiConversationId] = useState(() => piConversations[0].id);
  const composer = useComposerDrafts();
  const [composerFocus, setComposerFocus] = useState<string>();
  const navigatedRef = useRef(false);
  /** Conversations with a turn in flight. Each runs on its own; switching away does not stop it. */
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Running conversations currently held on a tool approval, including ones not on screen. */
  const [awaitingConversationIds, setAwaitingConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  /** The composer still holds a sent message the host has not accepted; queuing it would send it twice. */
  const [acceptingConversationIds, setAcceptingConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  const dispatchingQueueRef = useRef(new Set<string>());
  const [queueTick, setQueueTick] = useState(0);
  const piRunning = runningConversationIds.has(activePiConversationId);
  const [piRuntimeState, setPiRuntimeState] = useState<PiRuntimeState>();
  const [historyProblems, setHistoryProblems] = useState<Record<string, "failed" | "missing" | "incomplete" | undefined>>({});
  const [followProblems, setFollowProblems] = useState<Record<string, HistoryNotice | undefined>>({});
  const [historyListFailed, setHistoryListFailed] = useState(false);
  const summaryRequest = useRef(0);
  const [sourceNotice, setSourceNotice] = useState<{ conversationId: string; message: string }>();
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(loadAgentSettings);
  const [runOutcome, setRunOutcome] = useState<RunOutcomeFace>();
  const { store: botStore, profiles: bots, revision: botRevision, error: botLoadError } = useBotProfiles();
  const [botSaving, setBotSaving] = useState(false);
  const [botDraft, setBotDraft] = useState<{ draft: BotProfile; creating: boolean; revision?: number }>();
  const [botError, setBotError] = useState<string>();
  const botStorageError = featureText(locale, "Could not save. Check the connection and retry.");
  const editBot = (bot: BotProfile) => { setBotError(undefined); setBotDraft({ draft: { ...bot, appearance: { ...bot.appearance } }, creating: false, revision: botRevision }); };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsFromDrawer = useRef(false);
  const settingsOpener = useRef<HTMLElement | null>(null);
  /** Mounted from the first open on, so later opens and closes keep their animation. */
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("providers");
  const [settingsBotId, setSettingsBotId] = useState<string>();
  const openSettings = (section: SettingsSectionId = "providers", botId?: string) => {
    settingsFromDrawer.current = drawerOpen;
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsMounted(true);
    setDrawerOpen(false);
    setSettingsSection(section);
    setSettingsBotId(botId);
    setSettingsOpen(true);
  };
  const [themePreset, setThemePreset] = useState<ThemePresetId>(() =>
    resolveThemePreset(readSetting(THEME_KEY), project.theme.preset));
  const [permissionDefault, setPermissionDefault] = useState<"request" | "auto" | "allow-all" | undefined>(() => {
    const stored = readSetting(PERMISSION_DEFAULT_KEY);
    return stored === "request" || stored === "auto" || stored === "allow-all" ? stored : undefined;
  });
  const wasRunningRef = useRef<{ id: string; running: boolean }>({ id: "", running: false });
  const [dismissedApprovalKey, setDismissedApprovalKey] = useState<string | null>(null);
  const approvalAbortRefs = useRef(new Map<string, AbortController>());
  const piAbortRefs = useRef(new Map<string, AbortController>());
  const storedRunIds = useRef(new Map<string, Set<string>>());
  const preparingPiRefs = useRef(new Set<string>());
  const runStop = useRunStop(piAbortRefs, preparingPiRefs);
  /** Uploaded copies of draft attachments, so retrying a failed submission does not upload them again. */
  const uploadedFilesRef = useRef(new WeakMap<File, PiFileReference>());

  // Single entry for both modes: fixture replay (dev/preview) or the live backend
  // stream. Components never learn which one they got.
  const { events: sourceEvents, streams, streamId, setStreamId, enabledSlots } = useEventSource();
  const events = streamId ? sourceEvents : piEvents ?? sourceEvents;
  const activePiConversation = useMemo(
    () => piConversations.find((conversation) => conversation.id === activePiConversationId) ?? piConversations[0],
    [activePiConversationId, piConversations],
  );
  const knownBots = useMemo(() => {
    const knownBots = [...bots];
    for (const participant of piConversations.flatMap(conversation => [...conversation.availableBots ?? [], ...conversation.groupParticipants ?? []])) {
      if (!knownBots.some(bot => bot.id === participant.id)) knownBots.push({ ...(bots.find(bot => bot.presetId === participant.presetId) ?? bots[0]), ...participant });
    }
    return knownBots;
  }, [bots, piConversations]);
  const activeBot = knownBots.find(bot => bot.id === (activePiConversation.groupHostId ?? conversationBotId(botStore, activePiConversation) ?? agentSettings.presetId))
    ?? bots.find(bot => bot.presetId === agentSettings.presetId) ?? bots[0];
  const presetBot = (id: string) => {
    const bot = knownBots.find(bot => bot.id === id);
    if (bot) return bot;
    const participant = activePiConversation.groupParticipants?.find(bot => bot.id === id);
    const base = bots.find(bot => bot.presetId === (participant?.presetId ?? "assistant")) ?? bots[0];
    return participant ? { ...base, ...participant } : base;
  };
  const conversationTitle = (conversation: EphemeralPiConversation) => groupConversationTitle(conversation, locale,
    bots, id => BOT_NAMES[presetBot(id).presetId]);
  const piSessionItems = useMemo(
    () => piConversationSidebarItems(piConversations
      .filter((conversation) => conversation.events.length > 0 || conversation.stored || hasComposerState(composer.drafts[conversation.id]))
      .map((conversation) => titlePiConversation(conversation, composer.drafts[conversation.id]?.prompt
        || composer.drafts[conversation.id]?.attachments.map((file) => file.name).join(", ") || ""))
      .map(conversation => ({ ...conversation, title: conversationTitle(conversation) }))),
    [piConversations, composer.drafts, bots, locale],
  );
  const historyGroups = useSessionHistoryGroups(activePiConversationId, conversationHistoryGroup(
    piSessionItems.find(session => session.id === activePiConversationId)
      ?? { id: activePiConversationId, agentPreset: agentSettings.presetId }, botStore.conversations,
  ));

  // Mirrors the configurator's policy derivation so reasoning / tool / error states
  // render exactly as previewed.
  const reasoningRenderPolicy = useMemo(() => createReasoningRenderPolicy(project), []);
  const toolRenderPolicy = useMemo(
    () => ({
      showArgs: project.toolCalls.detail === "summary" ? ("safe" as const) : ("debug" as const),
      showResult: project.toolCalls.detail === "summary" ? ("summary" as const) : ("full" as const),
    }),
    [],
  );
  const historyCopy = copy.workspace.sessionSidebar;
  const historyProblem = historyProblems[activePiConversationId];
  const historyMessage = streamId ? undefined : followProblems[activePiConversationId] ?? (historyProblem === "missing" ? historyCopy.historyMissing
    : historyProblem === "incomplete" ? historyCopy.historyIncomplete
    : historyProblem ? historyCopy.historyFailed : historyListFailed ? historyCopy.listFailed
    : sourceNotice?.conversationId === activePiConversationId ? sourceNotice.message : undefined);
  const pendingQuestion = useMemo(() => pendingUserInput(events), [events]);
  useEffect(() => {
    if (!piRuntimeState || streamId) return;
    void getBrowserState().then((state) => outputPanel.setBrowserAvailable(state.available), () => outputPanel.setBrowserAvailable(false));
  }, [Boolean(piRuntimeState), streamId]);
  const questionProps = useUserInput(pendingQuestion, activePiConversationId, locale, isGroupConversation(activePiConversation));
  const pendingSetup = useMemo(() => pendingChannelSetup(events), [events]);
  const setupProps = useChannelSetup(pendingSetup, activePiConversationId, locale);
  const pendingVault = useMemo(() => pendingVaultRequest(events), [events]);
  const vaultRequestProps = useVaultRequest(pendingVault, activePiConversationId, locale);
  // Group chat: a group's routing is a debug event; only ?devtools=1 shows it in the chat.
  const visibleEvents = useMemo(() => isGroupConversation(activePiConversation) && !devtoolsRequested()
    ? events.filter((event) => event.visibility !== "debug") : events, [events, activePiConversationId]);
  // In a group, the member that started working and has produced nothing visible yet.
  const groupTyping = useMemo((): string | undefined => {
    if (!isGroupConversation(activePiConversation)) return undefined;
    let pending: string | undefined;
    for (const event of events) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === "group.member.started" && validParticipantId(payload.member)) pending = payload.member;
      else if (event.type === "run.finished" || event.type === "run.error") pending = undefined;
      else if (pending && /^(text|reasoning|tool\.call|artifact)\./.test(event.type)) {
        const ids = [event.messageId, payload.toolCallId, payload.textId, payload.reasoningId, payload.artifactId];
        if (ids.some((id) => typeof id === "string" && id.startsWith(`${pending}~`))) pending = undefined;
      }
    }
    return pending;
  }, [events, activePiConversationId]);
  const replayEvents = useMemo(() => branchReplayEvents(userInputEventsForReplay(historyFeedbackEvents(visibleEvents, activePiConversationId, historyMessage), questionCopy[locale].skipped))
    .map(identityEventForReplay).map(artifactEventForReplay), [visibleEvents, activePiConversationId, historyMessage, locale]);
  // Render the selected history immediately; an effect replay exposes the previous branch for one render.
  const viewModel = useMemo(() => createAgentUXViewModel(replayAgentUXEvents(replayEvents), {
    policy: {
      reasoning: reasoningRenderPolicy,
      tool: toolRenderPolicy,
      error: { showDeveloperMessage: !project.blocks.errorCollapse, showRawError: false },
      visibility: { show: "developer" },
    },
  }), [replayEvents, reasoningRenderPolicy, toolRenderPolicy]);
  const displayViewModel = useMemo(() => displayTaskPlans(localizePreviewViewModel(viewModel, locale), events, locale, Object.fromEntries(knownBots.map(bot => [bot.id, bot.name]))), [locale, viewModel, events, knownBots]);
  const liveOutputPanelItems = useMemo(() => refreshArtifactItems(outputPanel.items, displayViewModel.timeline), [outputPanel.items, displayViewModel]);
  const isWelcome = displayViewModel.timeline.length === 0;

  const activeProject = useMemo(
    () => ({ ...configuredProject,
      layout: { ...configuredProject.layout, slots: configuredProject.layout.slots.map((slot) => enabledSlots?.includes(slot.id) ? { ...slot, enabled: true } : slot) },
      output: { ...configuredProject.output, source: outputPanel.source === "console" ? "console" as const : "artifact" as const },
      conversation: streamId && !activityPreview ? configuredProject.conversation : {
        ...configuredProject.conversation, agentAvatar: false, userAvatar: false, speakerLabels: false,
      },
    }),
    [configuredProject, outputPanel.source, streamId, activityPreview, enabledSlots],
  );
  const modelBot = streamId || isGroupConversation(activePiConversation) ? undefined : activeBot;
  const activeModel = botModelConfiguration(activeProject, agentSettings, modelBot);
  const modelUnavailable = settingsUseProvider(activeModel.settings) && !activeModel.provider?.enabled
    ? settingsCopy[locale].agents.modelUnavailable : undefined;
  /** IM chats inherit this service unless their host-owned Bot overrides it; never save a key here. */
  const channelModel = useMemo(() => {
    const config = piRuntimeConfigurationForProvider(defaultProviderConnection(configuredProject));
    return config.providerDefinition && config.model ? { definition: config.providerDefinition, model: config.model } : undefined;
  }, [configuredProject]);
  const imChannels = useImChannels(settingsOpen && Boolean(piRuntimeState), channelModel);
  const routines = useRoutines(settingsOpen && Boolean(piRuntimeState));
  const mcpServers = useMcpServers((settingsOpen || Boolean(botDraft)) && Boolean(piRuntimeState));
  const memories = useMemories(settingsOpen && Boolean(piRuntimeState));
  const skills = useSkills((settingsOpen || Boolean(botDraft)) && Boolean(piRuntimeState));
  const learning = useLearning(settingsOpen && Boolean(piRuntimeState));
  const usage = useUsage(settingsOpen && Boolean(piRuntimeState));
  const vault = useVault(settingsOpen && Boolean(piRuntimeState));
  /** A routine's conversation opened from settings before this page has listed it. */
  const [pendingOpen, setPendingOpen] = useState<string>();
  const navigationRequest = useRef(0);
  const [pendingSource, setPendingSource] = useState<{ conversationId: string; artifactId?: string; textId?: string; runId?: string; loaded?: boolean }>();
  const artifactTimes = useMemo(() => artifactTimestamps(replayEvents), [replayEvents]);
  // Both approval modes answer above the composer, exactly where the configurator previewed
  // them. Each mode needs its own surface here: `ChatFrame` no longer places either one in the
  // transcript, so a mode without an overlay would leave a real run with nothing to click.
  const pendingApprovalTool = displayViewModel.timeline.find((item): item is AgentUXToolTimelineItem =>
    item.kind === "tool" && item.status === "awaiting_approval" && Boolean(item.approval),
  );
  const approvalKey = pendingApprovalTool ? approvalRequestKey(activePiConversationId, pendingApprovalTool.id, replayEvents) : undefined;
  const activeApprovalKey = useRef(approvalKey);
  activeApprovalKey.current = approvalKey;
  const liveApprovalTool = pendingApprovalTool && approvalKey !== dismissedApprovalKey
    ? pendingApprovalTool
    : undefined;
  // A finished run shows its outcome on the face for a moment before settling back to idle.
  // Only for the conversation on screen finishing, not for switching away from a running one.
  useEffect(() => {
    const previous = wasRunningRef.current;
    wasRunningRef.current = { id: activePiConversationId, running: piRunning };
    if (previous.id === activePiConversationId && previous.running && !piRunning) {
      const outcome = runOutcomeFace(events);
      if (!outcome) return;
      setRunOutcome(outcome);
      const timer = setTimeout(() => setRunOutcome(undefined), outcome === "success" ? 1400 : 2400);
      return () => clearTimeout(timer);
    }
  }, [piRunning, activePiConversationId]);
  const persona: AgentPersona = {
    kind: PRESET_AVATARS[agentSettings.presetId],
    name: activeBot.name,
    appearance: activeBot.appearance,
    state: avatarActivity({
      running: piRunning,
      awaitingUser: Boolean(liveApprovalTool || pendingQuestion),
      outcome: runOutcome,
      connectionLost: !piRunning && Boolean(followProblems[activePiConversationId]),
      drafting: Boolean(composer.drafts[activePiConversationId]?.prompt.trim()),
      timeline: displayViewModel.timeline,
    }),
  };
  const approveLive = async (toolCallId: string, decision: ApprovalDecision, signal?: AbortSignal) => {
    // Keep the same decision and request identity while a lost receipt is reconciled.
    const approval = approvalForReplay(toolCallId, events);
    const controller = new AbortController();
    approvalAbortRefs.current.set(activePiConversationId, controller);
    try {
      await submitPiApproval({ ...approval, decision, conversationId: activePiConversationId },
        { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (approvalKey && activeApprovalKey.current === approvalKey) setDismissedApprovalKey(approvalKey);
    } finally {
      if (approvalAbortRefs.current.get(activePiConversationId) === controller) approvalAbortRefs.current.delete(activePiConversationId);
    }
  };
  const inlineApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "inline" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="inline-runtime">
      <InlineApprovalSurface
        key={approvalKey}
        tool={liveApprovalTool}
        onConfirm={(decision, signal) => approveLive(liveApprovalTool.id, decision, signal)}
      />
    </div>
  ) : null;
  const userInputOverlay = vaultRequestProps ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="vault-input">
      <InlineApprovalPrompt key={JSON.stringify([activePiConversationId, pendingVault?.requestId])} {...vaultRequestProps} />
    </div>
  ) : questionProps ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="user-input">
      <InlineApprovalPrompt key={JSON.stringify([activePiConversationId, pendingQuestion?.requestId])} {...questionProps} />
    </div>
  ) : setupProps ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="channel-setup">
      <InlineApprovalPrompt key={JSON.stringify([activePiConversationId, pendingSetup?.requestId, pendingSetup?.stage, pendingSetup?.candidate?.id])} {...setupProps} />
    </div>
  ) : null;
  const externalApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "hidden" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay">
      <ExternalApprovalSurface
        key={approvalKey}
        tool={liveApprovalTool}
        onConfirm={(decision, signal) => approveLive(liveApprovalTool.id, decision, signal)}
      />
    </div>
  ) : null;

  const activeConversationIdRef = useRef(activePiConversationId);
  const transcriptScroll = useRef<TranscriptScroll | undefined>(undefined);
  const [searchTarget, setSearchTarget] = useState<{ conversationId: string; textId: string; nonce: string }>();
  activeConversationIdRef.current = activePiConversationId;
  const activeStreamIdRef = useRef(streamId);
  activeStreamIdRef.current = streamId;
  const messageSubmissions = useRef(new Map<string, ComposerDraft>());
  const messageBranch = useMessageBranch({ conversation: activePiConversation, enabled: !streamId, running: piRunning,
    submissions: messageSubmissions.current,
    async onResend(draft, sourceId) {
      if (activeConversationIdRef.current !== sourceId || activeStreamIdRef.current) return;
      const current = composer.drafts[sourceId];
      await submitToPi(draft.prompt, { ...composerRunOptions, attachments: draft.attachments,
        ...(current?.prompt === draft.prompt && current.attachments.length === draft.attachments.length && current.attachments.every(file => draft.attachments.some(original => original.id === file.id)) ? { draftSnapshot: { prompt: draft.prompt, attachmentIds: draft.attachments.map(file => file.id) } } : {}) });
    },
    async onReady(conversation, draft, action, sourceId) {
      const source = piConversations.find(entry => entry.id === sourceId);
      const botId = source && conversationBotId(botStore, source);
      if (botId) bindBotConversation(conversation.id, botId);
      setPiConversations(current => replacePiConversation(current, conversation));
      // A branch inherits the source's choice, except allow-all: that stays with the page it was armed on.
      const sourceMode = composer.drafts[sourceId]?.runOptions?.permissionMode;
      const options: ComposerRunOptions = {
        permissionMode: (sourceMode === "allow-all" ? undefined : sourceMode) ?? permissionDefault ?? piRuntimeState?.defaultPermissionMode ?? "request",
        budgetMode: composer.drafts[sourceId]?.runOptions?.budgetMode ?? "medium",
      };
      await composer.update(conversation, () => ({ ...draft, runOptions: options }));
      // A delayed fork must not steal navigation or run after the user has left its source.
      if (activeConversationIdRef.current !== sourceId || activeStreamIdRef.current) return;
      navigatedRef.current = true;
      activeConversationIdRef.current = conversation.id;
      setActivePiConversationId(conversation.id); setPiEvents([...conversation.events]);
      outputPanel.reset();
      setComposerFocus(conversation.id);
      if (action === "regenerate") void submitToPi(draft.prompt, { ...options, attachments: draft.attachments,
        draftSnapshot: { prompt: draft.prompt, attachmentIds: draft.attachments.map(file => file.id) } }, conversation);
    },
  });

  useEffect(() => {
    if (!composer.restored.length) return;
    setPiConversations((current) => {
      const known = new Set(current.map((entry) => entry.id));
      return [...current, ...composer.restored.filter((record) => !known.has(record.id)).map((record) => ({
        ...record.conversation, events: [], stored: record.hasHistory || Boolean(record.submission),
      }))];
    });
    // Resume the most recently edited draft only if the user has not already navigated/typed.
    if (!navigatedRef.current && !hasComposerState(composer.drafts[activeConversationIdRef.current])) {
      const { conversation } = composer.restored[0];
      activeConversationIdRef.current = conversation.id;
      setActivePiConversationId(conversation.id);
      setPiEvents([]);
      if (isAgentPresetId(conversation.agentPreset)) {
        setAgentSettings((current) => ({ ...current, presetId: conversation.agentPreset as AgentPresetId }));
      }
    }
  }, [composer.restored]);

  useEffect(() => {
    if (activePiConversation.stored && !piAbortRefs.current.has(activePiConversation.id)) {
      void loadStoredConversation(activePiConversation).catch(() => undefined);
    }
  }, [activePiConversation.id, activePiConversation.stored]);

  useEffect(() => {
    // After a reload, the host transcript decides whether a pending draft was accepted.
    for (const record of composer.restored) {
      if (!record.submission) continue;
      const conversation = piConversations.find((entry) => entry.id === record.id);
      if (conversation) composer.accepted(conversation, storedRunIds.current.get(record.id) ?? new Set());
    }
  }, [composer.restored, piConversations]);

  const searchConversations = useCallback(async (query: string, signal: AbortSignal, cursor?: string) => {
    const result = await searchStoredConversations(query, signal, undefined, cursor);
    if (!signal.aborted) setPiConversations((current) => {
      const known = new Set(current.map(entry => entry.id));
      const added = result.conversations.filter(entry => !known.has(entry.id));
      return added.length ? [...current, ...added.map(entry => ({ ...entry, events: [], stored: true, ...groupFields(entry) }))] : current;
    });
    if (!signal.aborted) for (const entry of result.conversations) {
      if (entry.running) void followRun({ ...entry, events: [], stored: true, ...groupFields(entry) });
    }
    return result;
  }, []);

  // Conversations saved by the host (earlier visits, other browsers, before a restart) appear in
  // the sidebar at once; their transcripts load when opened.
  const syncStoredConversations = () => {
    const request = ++summaryRequest.current;
    return listStoredConversations()
    .then(({ conversations: stored, unreadable }) => {
      if (request !== summaryRequest.current) return;
      setHistoryListFailed(unreadable.length > 0);
      const stubs = stored.filter((entry) => entry.eventCount > 0).map(storedStub);
      setPiConversations((current) => {
        const known = new Set(current.map((entry) => entry.id));
        return [...current.map((entry) => entry.events.length ? entry : stubs.find((stub) => stub.id === entry.id) ?? entry),
          ...stubs.filter((stub) => !known.has(stub.id))];
      });
      // Turns running on the host that this page is not following (begun while it was closed, or
      // started by the host itself: routines, IM chats): pick them up. Following twice is a no-op.
      const running = new Set(stored.filter((entry) => entry.running).map((entry) => entry.id));
      for (const stub of stubs) if (running.has(stub.id)) void followRun(stub);
      // Background group results get their own persisted turn after the foreground is idle.
      const selected = stored.find(entry => entry.id === activeConversationIdRef.current);
      const loaded = piConversations.find(entry => entry.id === selected?.id);
      if (selected && loaded && !selected.running && !piAbortRefs.current.has(selected.id) && selected.eventCount > loaded.events.length)
        void loadStoredConversation(loaded).catch(() => undefined);
      // The host knows which of them wait on the user, also for an approval announced before this
      // page followed it. A list read just before a new wait must not clear it: a running turn's
      // wait is cleared by its own stream, a finished one's here.
      setAwaitingConversationIds((current) => stored.reduce((next, entry) => entry.awaitingUser ? toggleIn(next, entry.id, true)
        : !entry.running ? toggleIn(next, entry.id, false) : next, current));
    })
    .catch(() => { if (request === summaryRequest.current) setHistoryListFailed(true); });
  };
  const syncStoredRef = useRef(syncStoredConversations);
  syncStoredRef.current = syncStoredConversations;
  useEffect(() => {
    void syncStoredRef.current();
    // While the page is open, runs the host starts on its own appear within a quarter minute.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void syncStoredRef.current(); }, 15_000);
    const focused = () => { if (document.visibilityState === "visible") void syncStoredRef.current(); };
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focused); document.removeEventListener("visibilitychange", focused); };
  }, []);

  useEffect(() => {
    const provider = defaultProviderConnection(configuredProject);
    void configurePiRuntime({
      ...piRuntimeConfigurationForProvider(provider),
      conversationId: activePiConversationId,
    })
      .then(setPiRuntimeState)
      .catch(() => getPiRuntimeState().then(setPiRuntimeState).catch(() => undefined));
  }, []);

  useEffect(() => {
    const tokens = themeTokens[themePreset];
    applyTheme(tokens, document.documentElement);
    if (frameRef.current) applyTheme(tokens, frameRef.current);
    storeSetting(THEME_KEY, themePreset);
  }, [themePreset]);

  const autoHiddenRails = useAutoHiddenRails(frameRef);

  const visibleLayoutSlots = useMemo(
    () => slotsForTemplate(activeProject.layout.slots, activeProject.template),
    [activeProject.layout.slots, activeProject.template],
  );
  const inRegion = (region: SlotConfig["region"]) =>
    visibleLayoutSlots.filter((slot) => slot.enabled && slot.region === region);
  const hasSidebar = inRegion("sidebar").length > 0;
  const hasRightPanel = inRegion("right-panel").length > 0;
  const leftSidebarMounted = hasSidebar && !autoHiddenRails.left;
  /** Too narrow for the sidebar column (phones): it becomes a drawer instead of disappearing. */
  const compact = hasSidebar && autoHiddenRails.left;
  useCompactDrawer(drawerRef, compact && drawerOpen, closeDrawer);
  // Widening past the breakpoint puts the sidebar back in place.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);
  const leftSidebarVisible = leftSidebarMounted && !leftCollapsed;
  // Available = it could be shown. Visible = the reader has opened it. Clicking an artifact
  // keys on the former, so a collapsed panel reopens instead of being bypassed for a modal.
  const rightPanelAvailable = hasRightPanel && !autoHiddenRails.right && !isWelcome;
  const rightPanelVisible = rightPanelAvailable && !rightCollapsed;

  function openArtifact(request: OutputPanelOpenRequest) {
    const item = normalizeOutputPanelRequest(request);
    const path = typeof request === "string" ? request : request.workspacePath;
    if (item.kind === "file" && path && !item.downloadUrl) {
      const author = artifactAuthor(item.id);
      item.downloadUrl = workspaceFileUrl(path, author ? presetBot(author).presetId : agentSettings.presetId, piRuntimeState?.workspace);
    }
    outputPanel.openItem(item, rightPanelAvailable);
  }

  useEffect(() => {
    if (!pendingSource || streamId || pendingSource.conversationId !== activePiConversationId) return;
    const unavailable = () => {
      if (!pendingSource.loaded) return;
      setPendingSource(undefined);
      setSourceNotice({ conversationId: activePiConversationId, message: featureText(locale, "The source chat is open, but this record is no longer available. Refresh the list and try again.") });
    };
    if (pendingSource.artifactId) {
      const artifact = displayViewModel.timeline.find(item => item.kind === "artifact" && item.id === pendingSource.artifactId);
      if (!artifact || artifact.kind !== "artifact") { unavailable(); return; }
      const origin = replayEvents.find(event => event.type.startsWith("artifact.") && event.payload.artifactId === artifact.id);
      const message = origin?.runId ? replayEvents.find(event => event.type === "text.started" && event.runId === origin.runId && event.payload.role === "assistant")
        ?? replayEvents.find(event => event.type === "text.started" && event.runId === origin.runId && event.payload.role === "user") : undefined;
      if (typeof message?.payload.textId === "string") setSearchTarget({ conversationId: activePiConversationId, textId: message.payload.textId, nonce: crypto.randomUUID() });
      setPendingSource(undefined);
      openArtifact(outputPanelItemFromRenderedArtifact(artifact, activeProject));
    } else {
      const message = replayEvents.find(event => event.type === "text.started" && (pendingSource.textId
        ? event.payload.textId === pendingSource.textId : event.runId === pendingSource.runId && event.payload.role === "assistant"));
      if (typeof message?.payload.textId !== "string") { unavailable(); return; }
      setSearchTarget({ conversationId: activePiConversationId, textId: message.payload.textId, nonce: crypto.randomUUID() });
      setPendingSource(undefined);
    }
  }, [pendingSource, activePiConversationId, displayViewModel.timeline, replayEvents, streamId, locale]);

  // An edited (or content-less) page has nothing to stream; it opens once saved, unless the user is
  // looking at another output source. Here rather than in OutputFrame, so a collapsed panel can open.
  // Only runs this page started or follows; the same `file:` id as the live preview's, one tab.
  const liveRunIds = useRef(new Set<string>());
  const lastTimeline = useRef({ conversationId: activePiConversationId, timeline: displayViewModel.timeline });
  useEffect(() => {
    const previous = lastTimeline.current;
    lastTimeline.current = { conversationId: activePiConversationId, timeline: displayViewModel.timeline };
    if (previous.conversationId !== activePiConversationId || previous.timeline === displayViewModel.timeline || outputPanel.source !== "artifact") return;
    const live = new Set(replayEvents.flatMap((event) => event.type.startsWith("tool.call.") && event.runId && liveRunIds.current.has(event.runId)
      ? [String(event.payload.toolCallId)] : []));
    for (const file of finishedHtmlEdits(previous.timeline, displayViewModel.timeline, (id) => live.has(id))) {
      openArtifact({ id: `file:${file.path}`, kind: "file", title: file.title, subtitle: file.path, workspacePath: file.path, revision: file.toolCallId });
    }
  }, [displayViewModel.timeline]);

  /** Shows the browser's live view in the Output panel, opening the panel if needed. */
  function showBrowser() {
    outputPanel.showSource("browser", rightPanelAvailable);
  }
  // An agent asking the user to take over brings the browser into view once per request.
  const takeoverRequest = pendingQuestion?.questions.some((question) => question.id === "browser_takeover") ? pendingQuestion.requestId : undefined;
  const shownTakeover = useRef<string>(undefined);
  useEffect(() => {
    if (!takeoverRequest || shownTakeover.current === takeoverRequest || !outputPanel.browserAvailable) return;
    shownTakeover.current = takeoverRequest;
    showBrowser();
  }, [takeoverRequest, outputPanel.browserAvailable]);

  const closeOutputPanelItem = outputPanel.closeItem;

  async function refreshPiRuntime() {
    const state = await getPiRuntimeState();
    setPiRuntimeState(state);
    return state;
  }

  async function synchronizePiRuntime(
    projectSnapshot = activeProject,
    conversationId = activePiConversationId,
    signal?: AbortSignal,
    bot?: Pick<BotProfile, "model">,
  ) {
    const { provider } = botModelConfiguration(projectSnapshot, agentSettings, bot);
    if (!provider?.enabled) throw new Error(settingsCopy[locale].agents.modelUnavailable);
    const state = await configurePiRuntime(
      {
        ...piRuntimeConfigurationForProvider(provider, sessionKeys[provider.id]),
        conversationId,
      },
      fetch,
      signal,
    );
    if (!state.available) throw new Error(state.error ?? "Pi runtime is unavailable.");
    if (state.provider !== provider.id || state.model !== provider.defaultModel) {
      throw new Error(
        "Pi did not activate the selected model " + provider.label + "/" + provider.defaultModel + ".",
      );
    }
    setPiRuntimeState(state);
    return state;
  }

  /**
   * One history load per conversation, shared: opening it starts the load and a prompt sent
   * meanwhile waits for it. It only fills a conversation that is still empty, so a late response
   * can never overwrite a turn on screen.
   */
  const historyLoadsRef = useRef(new Map<string, Promise<EphemeralPiConversation>>());
  function loadStoredConversation(conversation: EphemeralPiConversation) {
    const pending = historyLoadsRef.current.get(conversation.id);
    if (pending) return pending;
    const load = getStoredConversation(conversation.id)
      .then((stored) => {
        setFollowProblems((current) => ({ ...current, [conversation.id]: undefined }));
        setHistoryProblems((current) => ({ ...current, [conversation.id]: stored.incomplete ? "incomplete" : undefined }));
        storedRunIds.current.set(conversation.id, new Set(stored.events.flatMap((event) => event.runId ? [event.runId] : [])));
        const loaded = { ...conversation, title: stored.title, events: stored.events, stored: false, activeRunId: stored.activeRunId, ...groupFields(stored) };
        composer.accepted(loaded, storedRunIds.current.get(conversation.id)!);
        setPiConversations((current) => current.map((entry) => (
          entry.id === loaded.id && entry.events.length === 0 ? loaded : entry
        )));
        setPiEvents((current) => (
          activeConversationIdRef.current === loaded.id && (current?.length ?? 0) <= loaded.events.length
            ? [...loaded.events]
            : current
        ));
        setPendingSource(current => current?.conversationId === loaded.id ? { ...current, loaded: true } : current);
        return loaded;
      })
      .catch((error) => {
        setPendingSource(current => current?.conversationId === conversation.id ? undefined : current);
        const missing = error instanceof PiRequestError && error.status === 404;
        const unacceptedDraft = composer.restored.some((record) => record.id === conversation.id && !record.hasHistory);
        if (!missing || !unacceptedDraft) {
          setHistoryProblems((current) => ({ ...current, [conversation.id]: missing ? "missing" : "failed" }));
          throw error;
        }
        // A saved draft may belong to a submission that never reached the host.
        setHistoryProblems((current) => ({ ...current, [conversation.id]: undefined }));
        const unsaved = { ...conversation, stored: false };
        setPiConversations((current) => current.map((entry) => entry.id === unsaved.id && !entry.events.length ? unsaved : entry));
        return unsaved;
      })
      .finally(() => historyLoadsRef.current.delete(conversation.id));
    historyLoadsRef.current.set(conversation.id, load);
    return load;
  }

  /** Adds or removes one conversation from a set held in state. */
  const toggleIn = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    if (set.has(id) === on) return set;
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  async function submitToPi(prompt: string, context?: ComposerSubmitContext & { requestId?: string }, target = activePiConversation,
    queued?: { requestId: string; agentPreset: AgentPresetId; artifactSubmission?: import("./runtime/artifactForm").ArtifactSubmission }) {
    if (runningConversationIds.has(target.id)) return false;
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return false;
    const conversationId = target.id;
    const isGroup = isGroupConversation(target);
    // Synchronous guard: state updates land later, so a double submit could slip past `piRunning`.
    if (piAbortRefs.current.has(conversationId)) return false;
    const controller = new AbortController();
    piAbortRefs.current.set(conversationId, controller);
    preparingPiRefs.current.add(conversationId);
    setRunningConversationIds((current) => toggleIn(current, conversationId, true));
    // A queued follow-up belongs to its conversation's role, whichever one is on screen now.
    const presetId = queued?.agentPreset ?? agentSettings.presetId;
    const fromDraft = !queued && Boolean(context?.draftSnapshot);
    if (fromDraft) setAcceptingConversationIds((current) => toggleIn(current, conversationId, true));
    let nextConversation: EphemeralPiConversation = {
      ...titlePiConversation(target, normalizedPrompt),
      agentPreset: presetId,
    };
    let turnStartEventCount = nextConversation.events.length;
    let promptAttempted = false;
    let reattach = false;
    // The run keeps going when the user opens another conversation; only the one on screen is drawn.
    const showIfActive = (conversation: EphemeralPiConversation) => {
      if (activeConversationIdRef.current === conversation.id) setPiEvents([...conversation.events]);
    };
    const runId = queued?.requestId ?? context?.requestId ?? "pi_export_" + crypto.randomUUID();
    messageSubmissions.current.set(runId, { prompt: normalizedPrompt, attachments: (context?.attachments ?? [])
      .map((file, index) => ({ ...file, id: context?.draftSnapshot?.attachmentIds[index] ?? crypto.randomUUID() })) });
    liveRunIds.current.add(runId);
    runStop.bind(controller, runId);
    // The composer callback is bound to this conversation's draft, even after switching away.
    const onAccepted = () => {
      messageSubmissions.current.delete(runId);
      setFollowProblems((current) => ({ ...current, [conversationId]: undefined }));
      setHistoryProblems((current) => current[conversationId] === "incomplete" ? { ...current, [conversationId]: undefined } : current);
      composer.accepted(nextConversation, new Set([runId]));
      if (fromDraft) setAcceptingConversationIds((current) => toggleIn(current, conversationId, false));
      context?.onAccepted?.();
    };
    // Same coalescing as the configurator, from the same module, so a long reply does not slow
    // down as it grows here either. The conversation is still appended one event at a time.
    const commit = createPiFrameCommit<EphemeralPiConversation>((conversation) => {
      setPiConversations((current) => replacePiConversation(current, conversation));
      showIfActive(conversation);
    });
    try {
      const syncedBots = await syncBotProfiles();
      // Reopening and reattaching share this load; a new turn never starts from an empty stub.
      if (nextConversation.stored && nextConversation.events.length === 0) {
        nextConversation = await loadStoredConversation(nextConversation);
        turnStartEventCount = nextConversation.events.length;
      }
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      const botId = nextConversation.groupHostId ?? conversationBotId(syncedBots.store, nextConversation) ?? presetId;
      const targetBot = syncedBots.profiles.find(bot => bot.id === botId);
      const model = botModelConfiguration(activeProject, { ...agentSettings, presetId }, isGroup ? undefined : targetBot);
      setPiConversations((current) => replacePiConversation(current, nextConversation));
      showIfActive(nextConversation);
      // CLI local-login runs bring their own model unless the Bot has a provider override.
      if (isGroup || settingsUseProvider(model.settings)) await synchronizePiRuntime(activeProject, nextConversation.id, controller.signal, isGroup ? undefined : targetBot);
      const attachments: PiPromptAttachment[] = [];
      const referencedConversationIds: string[] = [];
      const attachmentScope = isGroup ? "shared" : presetId;
      for (const attachment of context?.attachments ?? []) {
        if (attachment.chatReference) { referencedConversationIds.push(attachment.chatReference.conversationId); continue; }
        if (attachment.reference) {
          await checkPiAttachment(attachment.reference, controller.signal);
          attachments.push(attachment.reference); continue;
        }
        let uploaded = uploadedFilesRef.current.get(attachment.file);
        if (uploaded?.scope !== attachmentScope) {
          uploaded = await uploadPiFile(attachment.file, attachmentScope, controller.signal);
          uploadedFilesRef.current.set(attachment.file, uploaded);
        }
        attachments.push(uploaded);
      }
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      if (context?.draftSnapshot) await composer.submitted(nextConversation, { requestId: runId, ...context.draftSnapshot });
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      preparingPiRefs.current.delete(conversationId);
      promptAttempted = true;
      for await (const event of (isGroup ? runGroupTurn : runPiTurn)({
        ...(isGroup ? { members: groupMembersOf(nextConversation) } : {}),
        conversationId: nextConversation.id,
        botId,
        availableBots: syncedBots.profiles.map(({ id, name, presetId }) => ({ id, name, presetId })),
        requestId: runId,
        artifactSubmission: queued?.artifactSubmission,
        prompt: normalizedPrompt,
        attachments,
        referencedConversationIds,
        provider: model.providerId,
        model: model.model,
        thinkingLevel: context?.budgetMode === "fast" ? "low" : context?.budgetMode === "expert" ? "high" : "medium",
        permissionMode: context?.permissionMode ?? "request",
        agentPreset: presetId,
        claudeCodeModelSource: model.settings.claudeCodeModelSource,
        codexModelSource: model.settings.codexModelSource,
        locale,
      }, { signal: controller.signal })) {
        if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) {
          commit.cancel();
          return false;
        }
        if (confirmsPromptAccepted(event)) onAccepted();
        if (event.type === "group.members.updated") nextConversation = { ...nextConversation, ...groupFields(event.payload) };
        nextConversation = appendPiConversationEvents(nextConversation, [event]);
        commit.push(nextConversation);
        if (event.type === "tool.call.awaiting_approval" || event.type === "run.awaiting_input") {
          // Waiting on the user, so it cannot wait on a frame.
          commit.flush();
          setAwaitingConversationIds((current) => toggleIn(current, conversationId, true));
        } else if (APPROVAL_SETTLED_EVENTS.has(event.type) || event.payload.inputRequestId) {
          setAwaitingConversationIds((current) => toggleIn(current, conversationId, false));
        }
      }
      commit.flush();
      // The host titles a new conversation with its model during the first turn.
      if (turnStartEventCount === 0 || isGroupConversation(nextConversation)) refreshConversationTitle(conversationId);
      // The turn already delivered its terminal; a metadata refresh failure must not reattach it.
      await refreshPiRuntime().catch(() => undefined);
    } catch (error) {
      // Cancelled, not flushed: a frame still queued holds the conversation as it was *before*
      // the error events were appended, and letting it land after the commit below would erase
      // them from the screen.
      commit.cancel();
      if (controller.signal.aborted) {
        // The abort severed the stream, so the server's own wrap-up events never arrive.
        // Close whatever is still open locally (text/tool/reasoning blocks + a cancelled
        // run terminal) so the transcript never keeps a half-finished turn.
        const closed = appendPiConversationEvents(nextConversation, promptAttempted ? piCancelledTurnEvents(nextConversation.events) : []);
        setPiConversations((current) => replacePiConversation(current, closed));
        showIfActive(closed);
      } else if (promptAttempted && !(error instanceof PiRequestError)) {
        // A lost connection cannot tell us whether the host is running or has just finished.
        // Reattach in either case and read its authoritative result; never replay the prompt.
        reattach = true;
      } else {
        const message = featureError(locale, error instanceof Error ? error : "Pi runtime failed.");
        // The prompt is only passed when this turn never emitted anything; mid-run the
        // transcript already shows it. Same helper the configurator uses, so a failed turn
        // reads the same in both.
        const errorEvents = piErrorTurnEvents({
          message,
          prompt: nextConversation.events.length === turnStartEventCount ? normalizedPrompt : undefined,
          runId,
        });
        nextConversation = appendPiConversationEvents(nextConversation, errorEvents);
        setPiConversations((current) => replacePiConversation(current, nextConversation));
        showIfActive(nextConversation);
      }
    } finally {
      preparingPiRefs.current.delete(conversationId);
      if (fromDraft && !reattach) setAcceptingConversationIds((current) => toggleIn(current, conversationId, false));
      if (piAbortRefs.current.get(conversationId) === controller) {
        piAbortRefs.current.delete(conversationId);
        if (!reattach) {
          setRunningConversationIds((current) => toggleIn(current, conversationId, false));
          setAwaitingConversationIds((current) => toggleIn(current, conversationId, false));
        }
      }
    }
    if (reattach) void followRun(nextConversation, { requestId: runId, prompt: normalizedPrompt, onAccepted });
    // Acceptance clears the composer explicitly; failures before it preserve the draft/files.
    return false;
  }

  /**
   * Watch a turn that runs on the host without this page having started it (a reload, a closed
   * tab, a dropped connection). The saved transcript replaces the local one, then live events
   * follow from exactly where it ends, so nothing is shown twice or skipped.
   */
  /** `preloaded`: `conversation` was just read from the host, so the first pass skips reading it again. */
  async function followRun(conversation: EphemeralPiConversation, submission?: { requestId: string; prompt: string; onAccepted?: () => void }, preloaded = false) {
    const conversationId = conversation.id;
    if (piAbortRefs.current.has(conversationId)) return;
    const controller = new AbortController();
    piAbortRefs.current.set(conversationId, controller);
    runStop.bind(controller, submission?.requestId ?? conversation.activeRunId);
    setRunningConversationIds((current) => toggleIn(current, conversationId, true));
    const showIfActive = (next: EphemeralPiConversation) => {
      if (activeConversationIdRef.current === next.id) setPiEvents([...next.events]);
    };
    const commit = createPiFrameCommit<EphemeralPiConversation>((next) => {
      if (piAbortRefs.current.get(conversationId) !== controller) return;
      setPiConversations((current) => replacePiConversation(current, next));
      showIfActive(next);
    });
    let current = conversation;
    let retries = 0;
    let reload = !preloaded;
    try {
      while (!controller.signal.aborted) {
        try {
          // A reconnect always reads again: the host may have moved on while the stream was down.
          if (reload) current = await loadStoredConversation(current);
          reload = true;
          if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
          if (controller.signal.aborted) break;
          runStop.bind(controller, current.activeRunId ?? [...current.events].reverse().find(event => event.type === "run.started")?.runId);
          // Saved and live events are the host's stored transcript; rejected prompts are never saved.
          if (submission && current.events.some((event) => event.runId === submission.requestId)) submission.onAccepted?.();
          setPiConversations((list) => replacePiConversation(list, current));
          showIfActive(current);
          const requestId = submission && !current.events.some((event) => event.runId === submission.requestId)
            ? submission.requestId : undefined;
          for await (const event of followPiTurn(conversationId, current.events.length, { signal: controller.signal, requestId })) {
            if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
            if (controller.signal.aborted) break;
            if (event.type === "run.started") runStop.bind(controller, event.runId);
            if (event.runId) liveRunIds.current.add(event.runId);
            if (submission && event.runId === submission.requestId) submission.onAccepted?.();
            retries = 0;
            if (event.type === "group.members.updated") current = { ...current, ...groupFields(event.payload) };
            current = appendPiConversationEvents(current, [event]);
            commit.push(current);
            if (event.type === "tool.call.awaiting_approval" || event.type === "run.awaiting_input") {
              commit.flush();
              setAwaitingConversationIds((ids) => toggleIn(ids, conversationId, true));
            } else if (APPROVAL_SETTLED_EVENTS.has(event.type) || event.payload.inputRequestId) {
              setAwaitingConversationIds((ids) => toggleIn(ids, conversationId, false));
            }
          }
          if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
          commit.flush();
          // A first turn started elsewhere (IM, another tab) is titled by the host as it ends.
          if (current.events.filter((event) => event.type === "run.started").length === 1) refreshConversationTitle(conversationId);
          break;
        } catch (error) {
          if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
          commit.flush();
          if (controller.signal.aborted) break;
          // A missing conversation or denied access is definitive; a network failure/5xx is not.
          if (error instanceof PiRequestError && error.status < 500) throw error;
          if (++retries >= 5) throw new Error(featureText(locale, "Could not reconnect after 5 attempts. The host task may still be running. Once connected, select this conversation again from the sidebar."));
          await waitForReconnect(controller.signal, Math.min(1000 * 2 ** (retries - 1), 5000));
        }
      }
      if (controller.signal.aborted) {
        // Stopped from here: the host's own wrap-up events are not coming over this stream.
        const closed = appendPiConversationEvents(current, piCancelledTurnEvents(current.events));
        setPiConversations((list) => replacePiConversation(list, closed));
        showIfActive(closed);
      }
    } catch (error) {
      if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
      // Connection failure is not a host terminal and must never advance its event cursor.
      setFollowProblems((problems) => ({ ...problems, [conversationId]: {
        message: featureError(locale, error instanceof Error ? error : "Pi runtime failed."),
        prompt: submission && !current.events.some((event) => event.runId === submission.requestId && event.type === "text.started"
          && (event.payload as { role?: string }).role === "user") ? submission.prompt : undefined,
        runId: submission?.requestId ?? [...current.events].reverse().find((event) => event.type === "run.started")?.runId
          ?? `pi_follow_${Date.now().toString(36)}`,
      } }));
    } finally {
      if (piAbortRefs.current.get(conversationId) === controller) {
        piAbortRefs.current.delete(conversationId);
        setRunningConversationIds((ids) => toggleIn(ids, conversationId, false));
        setAwaitingConversationIds((ids) => toggleIn(ids, conversationId, false));
      }
    }
  }

  /** Reads the host's copy of an opened conversation; follows it only if a run is in flight there. */
  async function refreshPiConversation(conversation: EphemeralPiConversation) {
    if (piAbortRefs.current.has(conversation.id)) return;
    const loaded = await loadStoredConversation(conversation).catch(() => undefined);
    if (!loaded || piAbortRefs.current.has(conversation.id)) return;
    if (loaded.activeRunId) {
      void followRun(loaded, undefined, true);
      return;
    }
    if (loaded.events.length <= conversation.events.length) return;
    setPiConversations((list) => list.map((entry) => entry.id === loaded.id ? loaded : entry));
    if (activeConversationIdRef.current === loaded.id) setPiEvents([...loaded.events]);
  }

  /** Stops the conversation on screen; runs in other conversations continue. Its queue pauses first. */
  const stopPi = (conversationId = activePiConversationId) => {
    composer.pauseQueue(conversationId, "stopped");
    approvalAbortRefs.current.get(conversationId)?.abort();
    return runStop.stop(conversationId);
  };

  // Follow-ups go one at a time, each only after the previous turn ended well; a stop, failure,
  // lost connection or reload pauses the queue until the user resumes it.
  useEffect(() => {
    if (streamId) return;
    for (const [conversationId, queue] of Object.entries(composer.queues)) {
      if (dispatchingQueueRef.current.has(conversationId)) continue;
      const conversation = piConversations.find((entry) => entry.id === conversationId);
      if (!conversation) continue;
      const step = nextQueueStep(queue, {
        running: runningConversationIds.has(conversationId) || piAbortRefs.current.has(conversationId),
        events: conversation.events,
        connectionFailed: Boolean(followProblems[conversationId]),
      });
      if (step.kind === "pause") composer.pauseQueue(conversationId, step.reason);
      else if (step.kind === "send") void sendQueued(conversation, step.item);
    }
  }, [composer.queues, runningConversationIds, piConversations, followProblems, streamId, queueTick]);

  async function sendQueued(conversation: EphemeralPiConversation, item: QueuedMessage) {
    dispatchingQueueRef.current.add(conversation.id);
    try {
      await submitToPi(queuedPrompt(item), {
        attachments: item.attachments.map(({ id: _id, ...attachment }) => attachment),
        permissionMode: item.runOptions?.permissionMode ?? permissionDefault ?? piRuntimeState?.defaultPermissionMode ?? "request",
        budgetMode: item.runOptions?.budgetMode ?? "medium",
        // Only the host's acceptance takes it off the queue; a rejected send stays for review.
        onAccepted: () => void composer.removeQueued(conversation, new Set([item.id])),
      }, conversation, { requestId: item.id, artifactSubmission: item.artifactSubmission, agentPreset: isAgentPresetId(conversation.agentPreset) ? conversation.agentPreset : agentSettings.presetId });
    } finally {
      dispatchingQueueRef.current.delete(conversation.id);
      setQueueTick((tick) => tick + 1);
    }
  }

  /** Resuming re-reads the host first: anything it already holds a turn for is dropped, not resent. */
  async function resumeQueue(conversation: EphemeralPiConversation) {
    let events = conversation.events;
    try {
      const loaded = await loadStoredConversation(conversation);
      if (!events.length) events = loaded.events;
      const accepted = storedRunIds.current.get(conversation.id);
      if (accepted) await composer.removeQueued(conversation, accepted);
      if (loaded.activeRunId) void followRun(conversation);
    } catch (error) {
      // Never saved on the host means nothing was accepted; any other read failure stays paused.
      if (!(error instanceof PiRequestError && error.status === 404)) return;
    }
    composer.resumeQueue(conversation.id, lastRunOutcome(events)?.runId);
  }

  async function selectProvider(id: ProviderConnectionId, model?: string) {
    const provider = activeProject.providers.connections.find((entry) => entry.id === id && entry.enabled);
    if (!provider || providerSelectionPending.current) return;
    const selectedModel = model ?? provider.defaultModel;
    const nextProvider = {
      ...provider,
      defaultModel: selectedModel,
      models: provider.models.includes(selectedModel) ? provider.models : [selectedModel, ...provider.models],
    };
    const nextProject = {
      ...activeProject,
      providers: {
        ...activeProject.providers,
        defaultProviderId: id,
        connections: activeProject.providers.connections.map((entry) => entry.id === provider.id ? nextProvider : entry),
      },
    };
    providerSelectionPending.current = true;
    setProviderSelectionError(undefined);
    try {
      if (modelBot?.model) {
        const bot = { ...modelBot, model: { provider: id, model: selectedModel } };
        await saveBotProfile(bot, botRevision);
        await synchronizePiRuntime(activeProject, activePiConversationId, undefined, bot);
      } else {
        await saveProviders(nextProject.providers);
        await synchronizePiRuntime(nextProject);
      }
    } catch (error) {
      setProviderSelectionError(featureError(locale, error));
    } finally { providerSelectionPending.current = false; }
  }

  function updateProvider(id: ProviderConnectionId, patch: Partial<ProviderConnection> & { authEnvVar?: string }) {
    setConfiguredProject((current) => ({
      ...current,
      providers: {
        ...current.providers,
        connections: current.providers.connections.map((provider) => provider.id === id ? {
          ...provider,
          ...patch,
          auth: patch.authEnvVar && provider.auth.mode === "env"
            ? { ...provider.auth, envVar: patch.authEnvVar }
            : provider.auth,
        } : provider),
      },
    }));
  }

  /**
   * Back to a clean welcome screen: deselect the stream and drop everything derived from it.
   * Leaving the artifact panel populated would show products of a conversation that is no
   * longer on screen.
   */
  /** A slow title service may still be answering when the turn ends: look once more a little later. */
  function refreshConversationTitle(id: string, retry = true) {
    void getStoredConversationSummary(id).then((summary) => {
      const { title, titleSource } = summary;
      setPiConversations((current) => current.map((entry) => entry.id === id && (entry.title !== title || summary.group)
        ? { ...entry, title, ...groupFields(summary) } : entry));
      if (titleSource !== "summary" && retry) setTimeout(() => refreshConversationTitle(id, false), 4_000);
    }).catch(() => undefined);
  }

  /** The host deletes the transcript; this page then forgets the conversation, its draft and queue. */
  async function deletePiConversation(id: string) {
    await deleteStoredConversation(id);
    try { forgetBotConversation(id); } catch { /* A stale local association cannot resurrect deleted history. */ }
    const conversation = piConversations.find((entry) => entry.id === id);
    if (conversation) void composer.update(conversation, () => ({ prompt: "", attachments: [] }), () => ({ items: [] }));
    storedRunIds.current.delete(id);
    if (activeConversationIdRef.current === id) await startNewSession();
    setPiConversations((current) => current.filter((entry) => entry.id !== id));
  }

  /** The host saves the title; the row shows it once saved. */
  async function renamePiConversation(id: string, title: string) {
    const saved = await renameStoredConversation(id, title);
    setPiConversations((current) => current.map((entry) => entry.id === id ? { ...entry, title: saved, titleSource: "user" } : entry));
  }

  /** A saved conversation the sidebar lists before its transcript is opened. */
  function storedStub(entry: StoredConversationSummary): EphemeralPiConversation {
    return { id: entry.id, title: entry.title, createdAt: entry.createdAt, agentPreset: entry.agentPreset,
      activeRunId: entry.activeRunId, events: [], stored: true, ...groupFields(entry) };
  }
  async function setGroupMembers(conversationId: string, members: string[]) {
    const previous = piConversations.find(entry => entry.id === conversationId);
    if (!previous) return;
    const saved = await updateGroupMembers(conversationId, members, bots.map(({ id, name, presetId }) => ({ id, name, presetId })),
      previous.groupHostId ?? conversationBotId(botStore, previous) ?? activeBot.id);
    const updated = { ...previous, title: saved.title, ...groupFields(saved) };
    setPiConversations(current => current.map(entry => entry.id === conversationId ? { ...entry, title: saved.title, ...groupFields(saved) } : entry));
    await composer.update(updated, draft => draft);
  }

  function startNewSession(group = false, members: string[] = ["assistant", "planner", "builder"], bot = activeBot) {
    navigationRequest.current++;
    setPendingOpen(undefined);
    setPendingSource(undefined);
    navigatedRef.current = true;
    // A run in flight keeps going in its own conversation; it only draws while on screen.
    const conversation = group
      ? { ...createEphemeralPiConversation(`group_${crypto.randomUUID().slice(0, 12)}`),
        title: groupRosterTitle(members.map(m => presetBot(m).name), locale), groupMembers: members, groupHostId: "assistant", groupParticipants: bots.map(({ id, name, presetId }) => ({ id, name, presetId })) }
      : { ...createEphemeralPiConversation(), agentPreset: bot.presetId };
    if (!group) {
      try { bindBotConversation(conversation.id, bot.id); setBotError(undefined); }
      catch { setBotError(botStorageError); return false; }
    }
    setStreamId("");
    if (group) composer.update(conversation, (draft) => draft);
    setPiConversations((current) => replacePiConversation(current, conversation));
    // Set at once, not on the next render: a background run's frame must not draw over this view.
    activeConversationIdRef.current = conversation.id;
    setActivePiConversationId(conversation.id);
    setPiEvents([]);
    void startNewPiSession(conversation.id)
      .then(setPiRuntimeState)
      .then(() => synchronizePiRuntime(activeProject, conversation.id, undefined, group ? undefined : bot))
      .catch(() => undefined);
    outputPanel.reset();
    setLeftCollapsed(false);
    // Collapsed, not opened: a fresh conversation has no output yet.
    setRightCollapsed(true);
    return true;
  }

  /**
   * A conversation belongs to one agent: its context lives in that harness's own session, so
   * switching agents starts fresh instead of pretending the new one remembers.
   */
  function changeAgentSettings(next: AgentSettings) {
    navigatedRef.current = true;
    const presetChanged = next.presetId !== agentSettings.presetId;
    setAgentSettings(next);
    saveAgentSettings(next);
    if (presetChanged && (activePiConversation.events.length > 0 || hasComposerState(composer.drafts[activePiConversationId]))) void startNewSession();
  }

  /** Clicking an agent is how a new conversation starts (there is no separate "new chat" button).
   *  An empty conversation on screen is reused rather than stacking another blank one. */
  function startConversationWith(presetId: AgentPresetId, bot = presetBot(presetId)) {
    navigationRequest.current++;
    setPendingOpen(undefined);
    setPendingSource(undefined);
    const needsNew = isGroupConversation(activePiConversation) || activePiConversation.events.length > 0 || piRunning
      || hasComposerState(composer.drafts[activePiConversationId]);
    if (needsNew) { if (!startNewSession(false, undefined, bot)) return false; }
    else {
      try { bindBotConversation(activePiConversationId, bot.id); setBotError(undefined); }
      catch { setBotError(botStorageError); return false; }
      setPiConversations(current => current.map(entry => entry.id === activePiConversationId ? { ...entry, agentPreset: presetId } : entry));
      setStreamId("");
    }
    navigatedRef.current = true;
    setDrawerOpen(false);
    const next = { ...agentSettings, presetId };
    setAgentSettings(next);
    saveAgentSettings(next);
    return true;
  }

  /** From settings (a routine's conversation): select it, listing it first if it is new here. */
  function openStoredConversation(conversationId: string, target?: { artifactId?: string; textId?: string; runId?: string }) {
    const request = ++navigationRequest.current;
    setPendingOpen(undefined);
    setSettingsOpen(false);
    setSourceNotice(undefined);
    setPendingSource(target ? { conversationId, ...target } : undefined);
    if (conversationId === activePiConversationId && !streamId) {
      if (target) void refreshPiConversation(activePiConversation);
      return;
    }
    if (piConversations.some((entry) => entry.id === conversationId)) { selectPiConversation(conversationId); return; }
    void listStoredConversations().then(({ conversations: stored }) => {
      if (navigationRequest.current !== request) return;
      const entry = stored.find((item) => item.id === conversationId);
      if (!entry) { setHistoryListFailed(true); setPendingSource(undefined); return; }
      setPiConversations((current) => current.some((item) => item.id === entry.id) ? current : [...current, storedStub(entry)]);
      setPendingOpen(conversationId);
      if (entry.running) void followRun(storedStub(entry));
    }).catch(() => { if (navigationRequest.current === request) { setHistoryListFailed(true); setPendingSource(undefined); } });
  }

  useEffect(() => {
    if (!pendingOpen || !piConversations.some((entry) => entry.id === pendingOpen)) return;
    setPendingOpen(undefined);
    selectPiConversation(pendingOpen);
  }, [pendingOpen, piConversations]);

  function selectPiConversation(conversationId: string) {
    navigationRequest.current++;
    setPendingOpen(undefined);
    setPendingSource(current => current?.conversationId === conversationId ? current : undefined);
    navigatedRef.current = true;
    setDrawerOpen(false);
    const conversation = piConversations.find((entry) => entry.id === conversationId);
    if (!conversation) return;
    setStreamId("");
    activeConversationIdRef.current = conversation.id;
    setActivePiConversationId(conversation.id);
    setPiEvents([...conversation.events]);
    // A conversation belongs to the role that answered it; reopening it brings that role back.
    if (isAgentPresetId(conversation.agentPreset) && conversation.agentPreset !== agentSettings.presetId) {
      const next = { ...agentSettings, presetId: conversation.agentPreset };
      setAgentSettings(next);
      saveAgentSettings(next);
    }
    // Cached history may have changed while detached or in another tab. Re-read it, and attach
    // only when the host reports a run: `followRun` marks the conversation running up front,
    // which on finished history showed a spinner and replayed every answer's typing.
    if (followProblems[conversation.id]) void followRun(conversation);
    else if (conversation.stored || conversation.events.length) void refreshPiConversation(conversation);
    outputPanel.reset();
    const selectedBot = isGroupConversation(conversation) ? undefined : knownBots.find(bot => bot.id === conversationBotId(botStore, conversation));
    void synchronizePiRuntime(activeProject, conversation.id, undefined, selectedBot).catch(() => undefined);
  }

  const slotContext: SlotRenderContext = {
    project: activeProject,
    viewModel: displayViewModel,
    events,
    // Must be set, not omitted. ChatFrame defaults this prop to a sample sentence ("Add
    // validation to the search input..."), so leaving it undefined prepended a user message
    // nobody sent to every exported app — while the configurator looked correct, because
    // App.tsx always passes a value. The default itself is load-bearing for 16 preset
    // rendering tests, so it stays; the omission here was the actual defect.
    // Pi user turns are canonical AgentUX events. A second prompt-history path would duplicate
    // bubbles and drift from the editor's event ordering.
    previewPrompt: "",
    activeSessionId: activePiConversationId,
    sessionItems: piSessionItems,
    onSelectSession: selectPiConversation,
    showDebugBadges: false,
    gitPreviewState: gitPreviewStateFromEvents(events),
    modelOptions: modelOptionsForProject(activeProject),
    isRunning: piRunning,
    onSubmit: submitToPi,
    onStop: () => stopPi(),
    onExport: noop,
    onGitCommit: noop,
    onProviderChange: (id) => void selectProvider(id),
    onModelChange: (model) => { if (activeModel.provider) void selectProvider(activeModel.provider.id, model); },
    onApprovalDecision: approveLive,
    onCollapseLeft: () => setLeftCollapsed(true),
    onCollapseRight: () => setRightCollapsed(true),
    onOpenArtifact: openArtifact,
    outputPanelItems: liveOutputPanelItems,
    activeOutputPanelItemId: outputPanel.activeItemId,
    onSelectOutputPanelItem: outputPanel.setActiveItemId,
    onCloseOutputPanelItem: closeOutputPanelItem,
    onOutputSourceChange: (source: "artifact" | "console") => { outputPanel.selectSource(source); },
    // Not a no-op: starting a new conversation needs no backend, it just clears the transcript
    // and returns to the welcome screen. Wiring it to `noop` made the button look broken —
    // the one control in the shell a user is guaranteed to try.
    onNewSession: startNewSession,
    // Each role greets in its own words; the configured greeting stays the fallback.
    welcomeGreeting: activeBot.id === activeBot.presetId
      ? (copy.composer.agentSettings.presets[agentSettings.presetId]?.greeting ?? activeProject.welcome.greeting).replaceAll(BOT_NAMES[agentSettings.presetId], activeBot.name)
      : featureText(locale, "Hi, I’m {name}", { name: activeBot.name }),
    isWelcome,
    defaultPermissionMode: permissionDefault ?? piRuntimeState?.defaultPermissionMode,
    // Settings opens from the sidebar footer and the header, not from the composer.
    providerSettingsControl: undefined,
  };

  const changeComposerDraft = (update: (draft: ComposerDraft) => ComposerDraft) => {
    const conversation = { ...activePiConversation, agentPreset: agentSettings.presetId };
    if (activePiConversation.agentPreset !== conversation.agentPreset) {
      setPiConversations(current => current.map(entry => entry.id === conversation.id ? { ...entry, agentPreset: conversation.agentPreset } : entry));
    }
    void composer.update(conversation, update);
  };
  // Every agent with a conversation in flight shows it, not only the one on screen.
  const agentStatuses: Record<string, AgentRunStatus> = {};
  for (const conversation of piConversations) {
    if (!runningConversationIds.has(conversation.id) || !isAgentPresetId(conversation.agentPreset)) continue;
    // Group runs keep their status in conversation history, not on one member's face.
    if (isGroupConversation(conversation)) continue;
    const waiting = awaitingConversationIds.has(conversation.id) || Boolean(pendingUserInput(conversation.events))
      || (conversation.id === activePiConversationId && Boolean(liveApprovalTool));
    const botId = conversationBotId(botStore, conversation) ?? conversation.agentPreset;
    if (waiting) agentStatuses[botId] = "needs-you";
    else agentStatuses[botId] ??= "running";
  }
  const activeTheme = themeTokens[themePreset];
  const themeVars = themeVariables(activeTheme);
  const composerRunOptions = {
    permissionMode: composer.drafts[activePiConversationId]?.runOptions?.permissionMode ?? permissionDefault ?? piRuntimeState?.defaultPermissionMode ?? "request",
    budgetMode: composer.drafts[activePiConversationId]?.runOptions?.budgetMode ?? "medium",
  } satisfies ComposerRunOptions;
  const recovery = useTaskRecovery({ conversation: activePiConversation, enabled: !streamId && !historyMessage, running: piRunning, locale,
    submissions: messageSubmissions.current,
    isCurrent: id => activeConversationIdRef.current === id && !activeStreamIdRef.current,
    configure: destination => destination === "browser" ? showBrowser() : openSettings(destination, activeBot.id),
    submit: async (draft, conversation, requestId) => {
      const current = composer.drafts[conversation.id];
      const sameDraft = current?.prompt === draft.prompt && current.attachments.length === draft.attachments.length
        && current.attachments.every(file => draft.attachments.some(original => original.id === file.id));
      await submitToPi(draft.prompt, { ...composerRunOptions, requestId, attachments: draft.attachments,
        ...(sameDraft ? { draftSnapshot: { prompt: current.prompt, attachmentIds: current.attachments.map(file => file.id) } } : {}) }, conversation);
    },
  });
  const workingMember = isGroupConversation(activePiConversation) ? workingGroupMember(events) : undefined;
  const botEditor: BotEditorState | undefined = botDraft ? {
    ...botDraft, models: configuredProject.providers.connections.filter(p => p.enabled).flatMap(p => [...new Set([p.defaultModel, ...p.models])].map(model => ({ provider: p.id, model, label: `${p.label} / ${model}` }))), mcpServers: mcpServers.servers, skills: skills.state?.skills, error: botError ?? botLoadError, saving: botSaving, ready: botRevision !== undefined,
    onChange: draft => { if (!botSaving) { setBotDraft({ ...botDraft, draft }); setBotError(undefined); } },
    onClose: () => { if (!botSaving) { setBotDraft(undefined); setBotError(undefined); } },
    onSave: async () => {
      if (botSaving) return;
      setBotSaving(true);
      try {
        const bot = { ...botDraft.draft, name: botDraft.draft.name.trim() };
        await saveBotProfile(bot, botDraft.revision ?? botRevision);
        if (botDraft.creating && !startConversationWith(bot.presetId, bot)) return;
        setBotDraft(undefined); setBotError(undefined);
      } catch (error) { setBotError(error instanceof Error ? featureError(locale, error) : botStorageError); }
      finally { setBotSaving(false); }
    },
  } : undefined;
  const shellExtras: ShellExtras = {
    taskRecovery: recovery,
    artifactCatalog: streamId ? undefined : { conversationId: activePiConversationId, conversationTitle: activePiConversation.title,
      timestamps: artifactTimes, openSource: entry => openStoredConversation(entry.conversationId, { artifactId: entry.artifactId }) },
    chatReferences: streamId ? undefined : piConversations.filter(c => c.id !== activePiConversationId && c.stored && !c.id.includes(".m.")).map(c => ({ id: c.id, title: conversationTitle(c) })),
    providerSelection: { onChange: (id, model) => void selectProvider(id, model), error: providerSelectionError ?? modelUnavailable,
      selected: { providerId: activeModel.providerId, model: activeModel.model } },
    bots: streamId ? undefined : knownBots,
    sessionBotIds: streamId ? undefined : botStore.conversations,
    onCreateBot: streamId ? undefined : () => {
      setBotError(undefined);
      setBotDraft({ creating: true, revision: botRevision, draft: { id: `bot_${crypto.randomUUID()}`, presetId: "assistant", name: "", appearance: { ...DEFAULT_NEW_BOT } } });
    },
    onEditBot: streamId ? undefined : editBot,
    botError: botDraft ? undefined : botError ?? (botLoadError ? `${featureText(locale, "Bot sync failed: ")}${botLoadError}` : undefined),
    botEditor,
    composerActivity: activityPreview ? {
      scope: `preview:${activePiConversationId}`,
      persona: activityPreview === "idle" ? undefined : { ...persona, state: activityPreview },
    } : streamId ? undefined : {
      scope: activePiConversationId,
      persona: piRunning ? {
        ...persona,
        ...(workingMember ? { kind: PRESET_AVATARS[presetBot(workingMember).presetId], name: presetBot(workingMember).name, appearance: presetBot(workingMember).appearance } : {}),
        state: groupTyping && persona.state !== "asking" ? "thinking" : persona.state,
      } : undefined,
    },
    runActive: streamId ? undefined : new Set(piRunning ? displayViewModel.timeline.slice(
      displayViewModel.timeline.map((item) => item.kind === "message" && item.role === "user").lastIndexOf(true) + 1,
    ).map((item) => item.id) : []),
    toolLog: streamId ? undefined : { targetId: outputPanel.toolLogTarget?.id, revision: outputPanel.toolLogTarget?.nonce, open: (id) => {
      outputPanel.showConsole(id, rightPanelAvailable);
    } },
    messageBranch,
    composerFocus: activePiConversationId === composerFocus ? composerFocus : undefined,
    transcriptScroll,
    agentSwitcher: (
      <AgentSwitcher
        avatars={PRESET_AVATARS}
        bots={streamId ? undefined : bots}
        activeBotId={activeBot.id}
        onSelectBot={bot => startConversationWith(bot.presetId, bot)}
        onEditBot={streamId ? undefined : editBot}
        activeId={agentSettings.presetId}
        statuses={agentStatuses}
        harnesses={piRuntimeState?.harnesses}
        onSelect={startConversationWith}
        groupActive={isGroupConversation(activePiConversation)}
      />
    ),
    groupHostId: isGroupConversation(activePiConversation) ? activePiConversation.groupHostId ?? "assistant" : undefined,
    groupTyping: runningConversationIds.has(activePiConversationId) ? groupTyping : undefined,
    welcomeGroup: isGroupConversation(activePiConversation) ? (
      <GroupWelcome avatars={PRESET_AVATARS} members={groupMembersOf(activePiConversation)} hostId={activePiConversation.groupHostId}
        onChange={(members) => setGroupMembers(activePiConversationId, members)} />
    ) : undefined,
    // Only groups still titled with their roster: the last thing said names the row instead.
    groupPreviews: groupConversationPreviews(piConversations,
      id => presetBot(id).name, id => BOT_NAMES[presetBot(id).presetId]),
    groupFaces: groupConversationFaces(piConversations, PRESET_AVATARS, id => presetBot(id).presetId),
    sidebarFooter: <SidebarFooter onOpenSettings={() => openSettings("providers")} />,
    headerAgent: <div className="shell-chat-participants">{isGroupConversation(activePiConversation) ? (
      <GroupHeader avatars={PRESET_AVATARS} members={groupMembersOf(activePiConversation)} hostId={activePiConversation.groupHostId}
        draft={activePiConversation.events.length === 0 && !activePiConversation.stored}
        onChange={(members) => setGroupMembers(activePiConversationId, members)} />
    ) : (
      <HeaderAgent
        avatars={PRESET_AVATARS}
        settings={activeModel.settings}
        bot={streamId ? undefined : activeBot}
        onEditBot={streamId ? undefined : editBot}
        onManageBot={streamId || !piRuntimeState ? undefined : section => openSettings(section, activeBot.id)}
        providerName={activeModel.provider?.label ?? activeModel.providerId}
        providerLabel={`${activeModel.provider?.label ?? activeModel.providerId} (${activeModel.model})${modelUnavailable ? ` — ${modelUnavailable}` : ""}`}
        onChange={changeAgentSettings}
        onManageProviders={() => openSettings("providers")}
      />
    )}<NewChatMenu avatars={PRESET_AVATARS}
      members={isGroupConversation(activePiConversation) ? groupMembersOf(activePiConversation) : [activeBot.id]}
      onNewGroup={(members) => setGroupMembers(activePiConversationId, members)} />
    </div>,
    searchConversations: streamId ? undefined : searchConversations,
    onDeleteSession: streamId ? undefined : deletePiConversation,
    onRenameSession: streamId ? undefined : renamePiConversation,
    runningSessionIds: runningConversationIds,
    unsentSessionIds: new Set(piConversations.filter((entry) => !entry.stored && entry.events.length === 0).map((entry) => entry.id)),
    onSelectSearchResult: (session) => {
      setSearchTarget(session.textId ? { conversationId: session.id, textId: session.textId, nonce: crypto.randomUUID() } : undefined);
      selectPiConversation(session.id);
    },
    transcriptTarget: !streamId && searchTarget?.conversationId === activePiConversationId ? searchTarget : undefined,
    sessionAvatars: Object.fromEntries(
      piConversations.flatMap((conversation) => (
        isAgentPresetId(conversation.agentPreset) ? [[conversation.id, PRESET_AVATARS[conversation.agentPreset]]] : []
      )),
    ),
    historyGroups,
    composerMentions: isGroupConversation(activePiConversation)
      ? groupMembersOf(activePiConversation).map((id) => ({ id, presetId: presetBot(id).presetId, name: presetBot(id).name, handle: presetBot(id).name, kind: PRESET_AVATARS[presetBot(id).presetId] }))
      : undefined,
    composerPlaceholder: isGroupConversation(activePiConversation) ? featureText(locale, "Message the group… (type @ to select members)")
      : settingsCopy[locale].shell.messageTo(activeBot.name),
    stopStatus: !streamId && piRunning ? runStop.statusFor(activePiConversationId) : undefined,
    composerOptions: {
      value: composerRunOptions,
      onChange: update => changeComposerDraft(current => ({ ...current, runOptions: { ...current.runOptions, ...update } })),
    },
    composerQueue: streamId ? undefined : {
      items: (composer.queues[activePiConversationId]?.items ?? []).map((item) => ({ id: item.id, prompt: queuedPrompt(item), attachmentCount: item.attachments.length })),
      paused: composer.queues[activePiConversationId]?.paused,
      canEnqueue: !acceptingConversationIds.has(activePiConversationId),
      canEdit: !hasComposerDraft(composer.drafts[activePiConversationId]),
      inputScope: activePiConversationId,
      onSteer: piRunning && agentSettings.presetId === "assistant" && !isGroupConversation(activePiConversation) ? async (text, requestId) => {
        const runId = activePiConversation.activeRunId ?? [...activePiConversation.events].reverse().find(event => event.type === "run.started")?.runId;
        if (!runId) throw new Error("No active run.");
        await steerPiTurn(activePiConversationId, runId, requestId, text);
      } : undefined,
      onEnqueue: (options) => void composer.enqueue({ ...activePiConversation, agentPreset: agentSettings.presetId }, options),
      onRemove: (id) => void composer.removeQueued(activePiConversation, new Set([id])),
      onEdit: (id) => void composer.editQueued(activePiConversation, id),
      onResume: () => void resumeQueue(activePiConversation),
    },
    composerDraft: {
      value: composer.drafts[activePiConversationId] ?? { prompt: "", attachments: [] },
      status: composer.statusFor(activePiConversationId),
      onChange: changeComposerDraft,
    },
    workspaceScope: agentSettings.presetId,
    workspaceBotName: activeBot.name,
    outputPanel: streamId ? undefined : { source: outputPanel.source, browserAvailable: outputPanel.browserAvailable, select: outputPanel.selectSource },
    workspaceRevision: piRunning,
    workspaceSharedAvailable: Boolean(piRuntimeState?.workspace?.shared),
    workspace: piRuntimeState?.workspace,
    onOpenFile: openArtifact,
    onBrowseWorkspace: streamId ? undefined : () => {
      outputPanel.showSource("workspace", rightPanelAvailable);
    },
    onAttachWorkspaceFile: streamId ? undefined : async (file) => {
      await composer.update(activePiConversation, (draft) => {
        if (draft.attachments.some(a => a.reference?.scope === file.scope && a.reference.path === file.path)) return draft;
        if (draft.attachments.length >= 10) throw new Error(featureText(locale, "At most 10 attachments"));
        return { ...draft, attachments: [...draft.attachments, { id: crypto.randomUUID(), name: file.name, isImage: false, reference: file }] };
      });
      outputPanel.setOutputModalOpen(false); outputPanel.setWorkspaceModalOpen(false);
      setComposerFocus(activePiConversation.id);
    },
    artifactForms: streamId ? undefined : {
      conversationId: activePiConversation.id,
      result: (requestId) => {
        const terminal = [...activePiConversation.events].reverse().find(event => event.runId === requestId && (event.type === "run.finished" || event.type === "run.error"));
        if (terminal) return terminal.type === "run.finished" && terminal.payload.status === "success" ? "completed" : "failed";
        if (composer.queues[activePiConversation.id]?.items.some(item => item.id === requestId)) return "queued";
        return activePiConversation.events.some(event => event.runId === requestId) ? "running" : undefined;
      },
      openResult: (requestId) => {
        const event = activePiConversation.events.find(e => e.runId === requestId && e.type === "text.started" && e.payload.role === "assistant");
        const textId = event?.payload.textId;
        if (typeof textId === "string") setSearchTarget({ conversationId: activePiConversation.id, textId, nonce: crypto.randomUUID() });
      },
      submit: async (requestId, prompt, artifactId) => {
        if (storedRunIds.current.get(activePiConversation.id)?.has(requestId)) return;
        await composer.enqueuePrompt({ ...activePiConversation, agentPreset: agentSettings.presetId }, prompt, composerRunOptions, requestId, artifactId);
      },
    },
    artifactThemeCss: artifactThemeCss((name) => themeVars[name] ?? "", activeTheme.appearance),
    onArtifactPrompt: streamId ? undefined : (text) => void composer.enqueuePrompt(
      { ...activePiConversation, agentPreset: agentSettings.presetId },
      text,
      composerRunOptions,
    ),
  };

  const previewOverlaySlots = renderSlots(
    visibleLayoutSlots.filter((slot) => slot.component === "OutputFrame"),
    "overlay",
    { ...slotContext, onCollapseRight: undefined },
  );

  const appearance = activeTheme.appearance;
  // Explicit opt-in even in dev: npm run dev is how recipients first inspect the package,
  // so debug chrome must not appear unless they ask for it with ?devtools=1.
  const showPicker = devtoolsRequested() && isFixtureMode && streams.length > 0;
  // String concat (not a template literal) so this file can be emitted from the exporter.
  const soloStack = (
    <section className="preview-stack preview-stack-solo" inert={compact && drawerOpen} data-welcome={isWelcome ? "true" : undefined}>
      {renderSlots(visibleLayoutSlots, "main", slotContext)}
      {inlineApprovalOverlay}
      {userInputOverlay}
      {externalApprovalOverlay}
      {renderSlots(visibleLayoutSlots, "bottom-dock", slotContext)}
      {renderSlots(visibleLayoutSlots, "composer", slotContext)}
    </section>
  );
  const mainSize = activeProject.layout.mainSize + "%";
  const rightSize = activeProject.layout.rightPanelSize + "%";

  return (
    // No inline layout: `.exported-shell` shares `.builder-surface`'s rule in app.css,
    // which is the sizing context `.preview-frame` and `.preview-overlay-surface` were
    // designed against. Re-implementing it here is what made the export "not fit".
    <CustomAvatarsProvider value={!streamId}>
    <AgentPersonaProvider persona={persona}>
    <ShellExtrasProvider value={shellExtras}>
    <div className="exported-shell">

      <>
        <div
          className="preview-frame"
          data-conversation-id={activePiConversationId}
          data-has-sidebar={hasSidebar}
          data-has-right-panel={rightPanelVisible}
          data-left-collapsed={leftCollapsed}
          data-right-collapsed={rightCollapsed}
          data-style-preset={project.theme.stylePreset}
          data-appearance={appearance}
          data-compact={compact ? "true" : undefined}
          ref={frameRef}
        >
          {leftSidebarMounted ? renderSlots(visibleLayoutSlots, "sidebar", slotContext) : null}
          {compact ? (
            <>
              <button
                type="button"
                className="rail-icon-btn preview-rail-float"
                data-side="left"
                aria-label={copy.shell.editor.expandSidebar}
                aria-expanded={drawerOpen}
                aria-controls="compact-sidebar"
                onClick={() => setDrawerOpen(true)}
              >
                <span className="native-rail-icon"><SidebarRailIcon size={17} /></span>
                <span className="legacy-rail-icon"><PanelLeft size={17} /></span>
              </button>
              <div className="compact-drawer-scrim" data-open={drawerOpen} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
              <div ref={drawerRef} id="compact-sidebar" className="compact-drawer" data-open={drawerOpen} inert={!drawerOpen}
                role="dialog" aria-modal={drawerOpen ? true : undefined} aria-label={copy.workspace.sessionSidebar.ariaLabel} tabIndex={-1}>
                {renderSlots(visibleLayoutSlots, "sidebar", { ...slotContext, onCollapseLeft: () => setDrawerOpen(false) })}
              </div>
            </>
          ) : null}
          {rightPanelVisible ? (
            <Suspense fallback={soloStack}>
              <RightPanelLayout
                mainSize={mainSize}
                rightSize={rightSize}
                main={(
                  <section className="preview-stack" data-welcome={isWelcome ? "true" : undefined}>
                    {renderSlots(visibleLayoutSlots, "main", slotContext)}
                    {inlineApprovalOverlay}
                    {userInputOverlay}
                    {externalApprovalOverlay}
                    {renderSlots(visibleLayoutSlots, "bottom-dock", slotContext)}
                    {renderSlots(visibleLayoutSlots, "composer", slotContext)}
                  </section>
                )}
                panel={renderSlots(visibleLayoutSlots, "right-panel", slotContext)}
              />
            </Suspense>
          ) : soloStack}
          {hasSidebar && leftCollapsed && !autoHiddenRails.left ? (
            <button
              type="button"
              className="rail-icon-btn preview-rail-float"
              data-side="left"
              aria-label={copy.shell.editor.expandSidebar}
              onClick={() => setLeftCollapsed(false)}
            >
              <span className="native-rail-icon"><SidebarRailIcon size={15} /></span>
              <span className="legacy-rail-icon"><PanelLeft size={15} /></span>
            </button>
          ) : null}
          {hasRightPanel && (autoHiddenRails.right || (rightPanelAvailable && rightCollapsed)) ? (
            <button
              type="button"
              className="rail-icon-btn preview-rail-float"
              data-side="right"
              inert={compact && drawerOpen}
              aria-label={copy.shell.editor.expandPanel}
              onClick={() => autoHiddenRails.right ? outputPanel.setWorkspaceModalOpen(true) : setRightCollapsed(false)}
            >
              <span className="native-rail-icon"><RightSidebarRailIcon size={15} /></span>
              <span className="legacy-rail-icon"><PanelRight size={15} /></span>
            </button>
          ) : null}
          {outputPanel.workspaceModalOpen ? (
            <Suspense fallback={null}>
              <OutputFrame project={activeProject} viewModel={displayViewModel} fullscreen openItems={liveOutputPanelItems} activeOpenItemId={outputPanel.activeItemId} onSelectOpenItem={outputPanel.setActiveItemId} onCloseOpenItem={closeOutputPanelItem} onSourceChange={(source) => { outputPanel.selectSource(source); }} onCollapse={() => outputPanel.setWorkspaceModalOpen(false)} />
            </Suspense>
          ) : null}
          {outputPanel.outputModalOpen ? (
            <Suspense fallback={null}>
              <OutputPanelModal
                items={liveOutputPanelItems}
                activeId={outputPanel.activeItemId}
                onSelectItem={outputPanel.setActiveItemId}
                onCloseItem={closeOutputPanelItem}
                onClose={() => outputPanel.setOutputModalOpen(false)}
              />
            </Suspense>
          ) : null}
        </div>
        {previewOverlaySlots.length > 0 ? (
          <aside className="preview-overlay-surface" data-preview-region="overlay">
            {previewOverlaySlots}
          </aside>
        ) : null}
      </>

      {/* Preview/development scaffolding — never product UI. Opt in with ?devtools=1;
          use ?stream=<id> to select a stream without any UI. */}
      {showPicker ? (
        <div
          style={{
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "10px",
            background: "var(--surface-panel)",
            boxShadow: "var(--shadow)",
          }}
        >
          <span style={{ fontSize: "11px", opacity: 0.55, whiteSpace: "nowrap" }}>
            {copy.shell.editor.eventStreamLabel}
          </span>
          <SelectMenu
            size="sm"
            value={streamId}
            onValueChange={(value) => {
              navigatedRef.current = true;
              setPiEvents(undefined);
              setStreamId(value);
            }}
            ariaLabel={copy.shell.editor.eventStreamAria}
            // The empty option is what "new conversation" returns to, and what the app opens
            // on. Without it the picker could never get back to the welcome screen.
            options={[
              { value: "", label: copy.shell.editor.eventStreamWelcome },
              ...streams.map((item) => ({ value: item.id, label: item.label })),
            ]}
          />
          <select aria-label={featureText(locale, "Activity avatar preview")} value={activityPreview}
            style={{ maxWidth: 112, fontSize: 12, color: "var(--text-secondary)", background: "var(--surface-panel)" }}
            onChange={(event) => setActivityPreview(event.target.value as AvatarState | "")}>
            <option value="">{featureText(locale, "Activity avatar preview")}</option>
            {(["thinking", "reading", "editing", "working", "writing", "asking"] as const).map((state) => (
              <option key={state} value={state}>{composerActivityCopy[locale][state]}</option>
            ))}
            <option value="idle">{featureText(locale, "Finished / Stopped")}</option>
          </select>
        </div>
      ) : null}
    </div>
        {settingsMounted ? (
          <Suspense fallback={null}>
            <SettingsDialog
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              onCloseAutoFocus={event => {
                const opener = settingsOpener.current;
                const trigger = !settingsFromDrawer.current && opener !== document.body
                  && opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]")
                  ? opener
                  : frameRef.current?.querySelector<HTMLElement>('.preview-rail-float[data-side="left"]')
                    ?? frameRef.current?.querySelector<HTMLElement>('.shell-footer-button');
                settingsFromDrawer.current = false;
                settingsOpener.current = null;
                if (trigger) { event.preventDefault(); trigger.focus({ preventScroll: true }); }
              }}
              initialSection={settingsSection}
              initialBotId={settingsBotId}
              initialMemoryScope={settingsBotId ? { kind: "bot", id: settingsBotId } : undefined}
            project={activeProject}
            providerSettingsStatus={providerSettingsStatus}
            runtime={piRuntimeState}
            isRunning={piRunning}
            sessionKeys={sessionKeys}
            savedProviderSettings={savedProviderSettings}
            onSaveProviders={async (providers, keys, removeKeys) => { await saveProviders(providers, keys, removeKeys); setSessionKeys({}); void refreshPiRuntime().catch(() => undefined); }}
            onSessionKeyChange={(id, value) => setSessionKeys((current) => ({ ...current, [id]: value }))}
            onUpdateProvider={updateProvider}
            // The model service may still lack a key; picking it as default must not throw.
            onSetDefaultProvider={(id) => void selectProvider(id).catch(() => undefined)}
            permissionDefault={permissionDefault}
            onPermissionDefaultChange={(mode) => {
              setPermissionDefault(mode);
              storeSetting(PERMISSION_DEFAULT_KEY, mode);
            }}
            themePreset={themePreset}
            onThemeChange={setThemePreset}
            imChannels={piRuntimeState ? imChannels : undefined}
            routines={piRuntimeState ? routines : undefined}
            mcpServers={piRuntimeState ? mcpServers : undefined}
            memories={piRuntimeState ? memories : undefined}
            memoryScopes={[{ scope: { kind: "global" }, label: featureText(locale, "Global") }, ...bots.map(bot => ({ scope: { kind: "bot" as const, id: bot.id }, label: bot.name })), ...piConversations.filter(c => c.stored && isGroupConversation(c)).map(c => ({ scope: { kind: "group" as const, id: c.id }, label: conversationTitle(c) }))]}
            learning={piRuntimeState ? learning : undefined}
            skills={piRuntimeState ? skills : undefined}
            usage={piRuntimeState ? usage : undefined}
            vault={piRuntimeState ? vault : undefined}
            onOpenConversation={openStoredConversation}
            />
          </Suspense>
        ) : null}
    </ShellExtrasProvider>
    </AgentPersonaProvider>
    </CustomAvatarsProvider>
  );
}
