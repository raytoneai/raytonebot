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
import type { SettingsSectionId } from "./components/settings/SettingsDialog";
import { AgentSwitcher, HeaderAgent, ShellExtrasProvider, SidebarFooter, type AgentRunStatus, type ShellExtras } from "./components/shell/ShellExtras";
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
import { applyTheme } from "./theme/applyTheme";
import { themeTokens, type ThemePresetId } from "./theme/themeTokens";
import { isFixtureMode, useEventSource } from "./event-source";
import { project } from "./exported-project";
import {
  checkPiAttachment,
  configurePiRuntime,
  getPiRuntimeState,
  getStoredConversation,
  followPiTurn,
  listStoredConversations,
  searchStoredConversations,
  resolvePiApproval,
  runPiTurn,
  uploadPiFile,
  startNewPiSession,
  PiRequestError,
  type PiFileReference,
  type PiPromptAttachment,
  type PiRuntimeState,
} from "./pi/piClient";
import { piRuntimeConfigurationForProvider } from "./pi/piProviderSync";
import { isAgentPresetId, loadAgentSettings, saveAgentSettings, settingsUseProvider, type AgentPresetId, type AgentSettings } from "./pi/harnessCatalog";
import { AgentPersonaProvider, type AgentPersona, type AvatarKind } from "./avatars/AgentPersona";
import type { TranscriptScroll } from "./runtime/useTranscriptScroll";
import { InlineApprovalPrompt } from "./components/agent-preview/chatframe/approval";
import { pendingUserInput, userInputEventsForReplay } from "./runtime/userInput";
import { useUserInput } from "./runtime/useUserInput";
import { approvalRequestKey } from "./runtime/approvalSubmission";
import { approvalForReplay, identityEventForReplay } from "./runtime/replayIdentity";
import { questionCopy } from "./i18n/copy/questions";
import { useRunStop } from "./runtime/runStop";
import { useProviderSettings } from "./runtime/useProviderSettings";
import { useImChannels } from "./runtime/useImChannels";

const THEME_KEY = "raytonebot.theme";
/** Events after which a tool call is no longer waiting on the user. */
const APPROVAL_SETTLED_EVENTS = new Set(["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished", "run.finished"]);
const PERMISSION_DEFAULT_KEY = "raytonebot.permissionDefault";

// Rejected requests also synthesize run.started + user text, so those are not acceptance.
// Any terminal other than a rejection means the host saved the prompt in the conversation.
const confirmsPromptAccepted = (event: AgentUXEvent) => event.type.startsWith("tool.call.")
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
import { artifactEventForReplay, refreshArtifactItems } from "./runtime/artifactContent";
import { displayTaskPlans } from "./runtime/taskPlan";
import { historyFeedbackEvents, type HistoryNotice } from "./runtime/historyFeedback";
import { hasComposerDraft, hasComposerState } from "./runtime/composerDraftStore";
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
const PREVIEW_RESPONSIVE_WIDTHS = {
  hideRightPanel: 860,
  hideLeftSidebar: 660,
} as const;

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
  const { locale } = useLocale();
  const copy = useCopy();
  const frameRef = useRef<HTMLDivElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /** Phones: the sidebar (agents, history, settings) lives in a drawer opened from the top left. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Closed until asked for, matching the configurator: a run with nothing to show should not
  // hand half the canvas to an empty output panel. Opens on the drawer toggle or on clicking an
  // artifact in the conversation.
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [autoHiddenRails, setAutoHiddenRails] = useState({ left: false, right: false });
  const [outputPanelItems, setOutputPanelItems] = useState<OutputPanelItem[]>([]);
  const [activeOutputPanelItemId, setActiveOutputPanelItemId] = useState<string | undefined>(undefined);
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [outputSource, setOutputSource] = useState(project.output.source);
  const [sessionKeys, setSessionKeys] = useState<Record<string, string>>({});
  const { project: configuredProject, setProject: setConfiguredProject, status: providerSettingsStatus } = useProviderSettings(project);
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
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(loadAgentSettings);
  const [celebrating, setCelebrating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Mounted from the first open on, so later opens and closes keep their animation. */
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("providers");
  const openSettings = (section: SettingsSectionId = "providers") => {
    setSettingsMounted(true);
    setDrawerOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  const [themePreset, setThemePreset] = useState<ThemePresetId>(() => {
    const stored = readSetting(THEME_KEY);
    return stored && stored in themeTokens ? stored as ThemePresetId : project.theme.preset;
  });
  const [permissionDefault, setPermissionDefault] = useState<"request" | "auto" | "allow-all" | undefined>(() => {
    const stored = readSetting(PERMISSION_DEFAULT_KEY);
    return stored === "request" || stored === "auto" || stored === "allow-all" ? stored : undefined;
  });
  const wasRunningRef = useRef<{ id: string; running: boolean }>({ id: "", running: false });
  const [dismissedApprovalKey, setDismissedApprovalKey] = useState<string | null>(null);
  const piAbortRefs = useRef(new Map<string, AbortController>());
  const storedRunIds = useRef(new Map<string, Set<string>>());
  const preparingPiRefs = useRef(new Set<string>());
  const runStop = useRunStop(piAbortRefs, preparingPiRefs);
  /** Uploaded copies of draft attachments, so retrying a failed submission does not upload them again. */
  const uploadedFilesRef = useRef(new WeakMap<File, PiFileReference>());

  // Single entry for both modes: fixture replay (dev/preview) or the live backend
  // stream. Components never learn which one they got.
  const { events: sourceEvents, streams, streamId, setStreamId } = useEventSource();
  const events = streamId ? sourceEvents : piEvents ?? sourceEvents;
  const activePiConversation = useMemo(
    () => piConversations.find((conversation) => conversation.id === activePiConversationId) ?? piConversations[0],
    [activePiConversationId, piConversations],
  );
  const piSessionItems = useMemo(
    () => piConversationSidebarItems(piConversations
      .filter((conversation) => conversation.events.length > 0 || conversation.stored || hasComposerState(composer.drafts[conversation.id]))
      .map((conversation) => titlePiConversation(conversation, composer.drafts[conversation.id]?.prompt
        || composer.drafts[conversation.id]?.attachments.map((file) => file.name).join(", ") || ""))),
    [piConversations, composer.drafts],
  );

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
    : historyProblem ? historyCopy.historyFailed : historyListFailed ? historyCopy.listFailed : undefined);
  const pendingQuestion = useMemo(() => pendingUserInput(events), [events]);
  const questionProps = useUserInput(pendingQuestion, activePiConversationId, locale);
  const replayEvents = useMemo(() => branchReplayEvents(userInputEventsForReplay(historyFeedbackEvents(events, activePiConversationId, historyMessage), questionCopy[locale].skipped))
    .map(identityEventForReplay).map(artifactEventForReplay), [events, activePiConversationId, historyMessage, locale]);
  // Render the selected history immediately; an effect replay exposes the previous branch for one render.
  const viewModel = useMemo(() => createAgentUXViewModel(replayAgentUXEvents(replayEvents), {
    policy: {
      reasoning: reasoningRenderPolicy,
      tool: toolRenderPolicy,
      error: { showDeveloperMessage: !project.blocks.errorCollapse, showRawError: false },
      visibility: { show: "developer" },
    },
  }), [replayEvents, reasoningRenderPolicy, toolRenderPolicy]);
  const displayViewModel = useMemo(() => displayTaskPlans(localizePreviewViewModel(viewModel, locale), events, locale), [locale, viewModel, events]);
  const liveOutputPanelItems = useMemo(() => refreshArtifactItems(outputPanelItems, displayViewModel.timeline), [outputPanelItems, displayViewModel]);
  const isWelcome = displayViewModel.timeline.length === 0;

  const activeProject = useMemo(
    () => ({ ...configuredProject, output: { ...configuredProject.output, source: outputSource } }),
    [configuredProject, outputSource],
  );
  /** IM chats run on the default model service; its definition (never a key) is saved with them. */
  const channelModel = useMemo(() => {
    const config = piRuntimeConfigurationForProvider(defaultProviderConnection(configuredProject));
    return config.providerDefinition && config.model ? { definition: config.providerDefinition, model: config.model } : undefined;
  }, [configuredProject]);
  const imChannels = useImChannels(settingsOpen && Boolean(piRuntimeState), channelModel);
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
  // A finished run gets a moment of the "done" face before settling back to idle.
  // Only for the conversation on screen finishing, not for switching away from a running one.
  useEffect(() => {
    const previous = wasRunningRef.current;
    wasRunningRef.current = { id: activePiConversationId, running: piRunning };
    if (previous.id === activePiConversationId && previous.running && !piRunning) {
      setCelebrating(true);
      const timer = setTimeout(() => setCelebrating(false), 1400);
      return () => clearTimeout(timer);
    }
  }, [piRunning, activePiConversationId]);
  const persona: AgentPersona = {
    kind: PRESET_AVATARS[agentSettings.presetId],
    name: copy.composer.agentSettings.presets[agentSettings.presetId].name,
    state: liveApprovalTool || pendingQuestion ? "warning" : piRunning ? "waiting" : celebrating ? "success" : "idle",
  };
  const approveLive = async (toolCallId: string, decision: ApprovalDecision) => {
    // Dismissed once the host has the answer, or says it is no longer pending (a stopped run
    // answers 409). A transport failure throws instead: the surface stays up for a retry.
    const approval = approvalForReplay(toolCallId, events);
    await resolvePiApproval(approval.toolCallId, decision, activePiConversationId, approval.runId);
    if (approvalKey && activeApprovalKey.current === approvalKey) setDismissedApprovalKey(approvalKey);
  };
  const inlineApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "inline" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="inline-runtime">
      <InlineApprovalSurface
        key={approvalKey}
        tool={liveApprovalTool}
        onConfirm={(decision) => approveLive(liveApprovalTool.id, decision)}
      />
    </div>
  ) : null;
  const userInputOverlay = questionProps ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="user-input">
      <InlineApprovalPrompt key={JSON.stringify([activePiConversationId, pendingQuestion?.requestId])} {...questionProps} />
    </div>
  ) : null;
  const externalApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "hidden" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay">
      <ExternalApprovalSurface
        key={approvalKey}
        tool={liveApprovalTool}
        onConfirm={(decision) => approveLive(liveApprovalTool.id, decision)}
      />
    </div>
  ) : null;

  const activeConversationIdRef = useRef(activePiConversationId);
  const transcriptScroll = useRef<TranscriptScroll | undefined>(undefined);
  const [searchTarget, setSearchTarget] = useState<{ conversationId: string; textId: string; nonce: string }>();
  activeConversationIdRef.current = activePiConversationId;
  const activeStreamIdRef = useRef(streamId);
  activeStreamIdRef.current = streamId;
  const messageBranch = useMessageBranch({ conversation: activePiConversation, enabled: !streamId, running: piRunning,
    async onReady(conversation, draft, action, sourceId) {
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
      setOutputPanelItems([]); setActiveOutputPanelItemId(undefined); setOutputModalOpen(false);
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
      return added.length ? [...current, ...added.map(entry => ({ ...entry, events: [], stored: true }))] : current;
    });
    if (!signal.aborted) for (const entry of result.conversations) {
      if (entry.running) void followRun({ ...entry, events: [], stored: true });
    }
    return result;
  }, []);

  // Conversations saved by the host (earlier visits, other browsers, before a restart) appear in
  // the sidebar at once; their transcripts load when opened.
  useEffect(() => {
    void listStoredConversations()
      .then(({ conversations: stored, unreadable }) => {
        setHistoryListFailed(unreadable.length > 0);
        const stubs = stored
          .filter((entry) => entry.eventCount > 0)
          .map((entry): EphemeralPiConversation => ({
            id: entry.id,
            title: entry.title,
            createdAt: entry.createdAt,
            agentPreset: entry.agentPreset,
            activeRunId: entry.activeRunId,
            events: [],
            stored: true,
          }));
        setPiConversations((current) => {
          const known = new Set(current.map((entry) => entry.id));
          return [...current.map((entry) => entry.events.length ? entry : stubs.find((stub) => stub.id === entry.id) ?? entry),
            ...stubs.filter((stub) => !known.has(stub.id))];
        });
        // Turns that kept running on the host while this page was closed: pick them up.
        const running = new Set(stored.filter((entry) => entry.running).map((entry) => entry.id));
        for (const stub of stubs) if (running.has(stub.id)) void followRun(stub);
      })
      .catch(() => setHistoryListFailed(true));
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
    const tokens = themeTokens[themePreset] ?? Object.values(themeTokens)[0];
    applyTheme(tokens, document.documentElement);
    if (frameRef.current) applyTheme(tokens, frameRef.current);
  }, [themePreset]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateAutoHiddenRails = (width: number) => {
      const next = {
        right: width < PREVIEW_RESPONSIVE_WIDTHS.hideRightPanel,
        left: width < PREVIEW_RESPONSIVE_WIDTHS.hideLeftSidebar,
      };
      setAutoHiddenRails((current) =>
        current.left === next.left && current.right === next.right ? current : next,
      );
    };

    updateAutoHiddenRails(frame.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      updateAutoHiddenRails(entries[0]?.contentRect.width ?? frame.getBoundingClientRect().width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

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
  // Escape closes the drawer; widening past the breakpoint puts the sidebar back in place.
  useEffect(() => {
    if (!compact) {
      setDrawerOpen(false);
      return;
    }
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, drawerOpen]);
  const leftSidebarVisible = leftSidebarMounted && !leftCollapsed;
  // Available = it could be shown. Visible = the reader has opened it. Clicking an artifact
  // keys on the former, so a collapsed panel reopens instead of being bypassed for a modal.
  const rightPanelAvailable = hasRightPanel && !autoHiddenRails.right && !isWelcome;
  const rightPanelVisible = rightPanelAvailable && !rightCollapsed;

  function openArtifact(request: OutputPanelOpenRequest) {
    const item = normalizeOutputPanelRequest(request);
    const path = typeof request === "string" ? request : request.workspacePath;
    if (item.kind === "file" && path && !item.downloadUrl) {
      item.downloadUrl = workspaceFileUrl(path, agentSettings.presetId, piRuntimeState?.workspace);
    }
    setOutputPanelItems((current) => {
      const index = current.findIndex((entry) => entry.id === item.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = item;
        return next;
      }
      return [...current, item];
    });
    setWorkspaceModalOpen(false);
    setActiveOutputPanelItemId(item.id);
    setOutputSource("artifact");
    if (rightPanelAvailable) {
      setOutputModalOpen(false);
      setRightCollapsed(false);
      return;
    }
    setOutputModalOpen(true);
  }

  function closeOutputPanelItem(id: string) {
    setOutputPanelItems((current) => {
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === 0) {
        setOutputModalOpen(false);
        setActiveOutputPanelItemId(undefined);
      } else if (activeOutputPanelItemId === id) {
        setActiveOutputPanelItemId(next[0].id);
      }
      return next;
    });
  }

  async function refreshPiRuntime() {
    const state = await getPiRuntimeState();
    setPiRuntimeState(state);
    return state;
  }

  async function synchronizePiRuntime(
    projectSnapshot = activeProject,
    conversationId = activePiConversationId,
    signal?: AbortSignal,
  ) {
    const provider = defaultProviderConnection(projectSnapshot);
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
        const loaded = { ...conversation, title: stored.title, events: stored.events, stored: false, activeRunId: stored.activeRunId };
        composer.accepted(loaded, storedRunIds.current.get(conversation.id)!);
        setPiConversations((current) => current.map((entry) => (
          entry.id === loaded.id && entry.events.length === 0 ? loaded : entry
        )));
        setPiEvents((current) => (
          activeConversationIdRef.current === loaded.id && (current?.length ?? 0) <= loaded.events.length
            ? [...loaded.events]
            : current
        ));
        return loaded;
      })
      .catch((error) => {
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

  async function submitToPi(prompt: string, context?: ComposerSubmitContext, target = activePiConversation,
    queued?: { requestId: string; agentPreset: AgentPresetId }) {
    if (runningConversationIds.has(target.id)) return false;
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return false;
    const conversationId = target.id;
    // Synchronous guard: state updates land later, so a double submit could slip past `piRunning`.
    if (piAbortRefs.current.has(conversationId)) return false;
    const provider = defaultProviderConnection(activeProject);
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
    const runId = queued?.requestId ?? "pi_export_" + crypto.randomUUID();
    runStop.bind(controller, runId);
    // The composer callback is bound to this conversation's draft, even after switching away.
    const onAccepted = () => {
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
      // Reopening and reattaching share this load; a new turn never starts from an empty stub.
      if (nextConversation.stored && nextConversation.events.length === 0) {
        nextConversation = await loadStoredConversation(nextConversation);
        turnStartEventCount = nextConversation.events.length;
      }
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      setPiConversations((current) => replacePiConversation(current, nextConversation));
      showIfActive(nextConversation);
      // Codex and a locally logged-in Claude Code bring their own model; only roles that run
      // on the configured model service need it registered (and its key handed over) first.
      if (settingsUseProvider({ ...agentSettings, presetId })) await synchronizePiRuntime(activeProject, nextConversation.id, controller.signal);
      const attachments: PiPromptAttachment[] = [];
      for (const attachment of context?.attachments ?? []) {
        if (attachment.reference) {
          await checkPiAttachment(attachment.reference, controller.signal);
          attachments.push(attachment.reference); continue;
        }
        let uploaded = uploadedFilesRef.current.get(attachment.file);
        if (uploaded?.scope !== presetId) {
          uploaded = await uploadPiFile(attachment.file, presetId, controller.signal);
          uploadedFilesRef.current.set(attachment.file, uploaded);
        }
        attachments.push(uploaded);
      }
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      if (context?.draftSnapshot) await composer.submitted(nextConversation, { requestId: runId, ...context.draftSnapshot });
      if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) return false;
      preparingPiRefs.current.delete(conversationId);
      promptAttempted = true;
      for await (const event of runPiTurn({
        conversationId: nextConversation.id,
        requestId: runId,
        prompt: normalizedPrompt,
        attachments,
        provider: provider.id,
        model: provider.defaultModel,
        thinkingLevel: context?.budgetMode === "fast" ? "low" : context?.budgetMode === "expert" ? "high" : "medium",
        permissionMode: context?.permissionMode ?? "request",
        agentPreset: presetId,
        claudeCodeModelSource: agentSettings.claudeCodeModelSource,
        codexModelSource: agentSettings.codexModelSource,
      }, { signal: controller.signal })) {
        if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) {
          commit.cancel();
          return false;
        }
        if (confirmsPromptAccepted(event)) onAccepted();
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
        const message = error instanceof Error ? error.message : "Pi runtime failed.";
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
  async function followRun(conversation: EphemeralPiConversation, submission?: { requestId: string; prompt: string; onAccepted?: () => void }) {
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
    try {
      while (!controller.signal.aborted) {
        try {
          current = await loadStoredConversation(current);
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
            if (submission && event.runId === submission.requestId) submission.onAccepted?.();
            retries = 0;
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
          break;
        } catch (error) {
          if (piAbortRefs.current.get(conversationId) !== controller) { commit.cancel(); return; }
          commit.flush();
          if (controller.signal.aborted) break;
          // A missing conversation or denied access is definitive; a network failure/5xx is not.
          if (error instanceof PiRequestError && error.status < 500) throw error;
          if (++retries >= 5) throw new Error("连续 5 次无法连接主机，已停止本地重连；未确认主机任务已停止。恢复连接后请从侧栏重新选择此会话。");
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
        message: error instanceof Error ? error.message : "Pi runtime failed.",
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
      void followRun(loaded);
      return;
    }
    if (loaded.events.length <= conversation.events.length) return;
    setPiConversations((list) => list.map((entry) => entry.id === loaded.id ? loaded : entry));
    if (activeConversationIdRef.current === loaded.id) setPiEvents([...loaded.events]);
  }

  /** Stops the conversation on screen; runs in other conversations continue. Its queue pauses first. */
  const stopPi = (conversationId = activePiConversationId) => {
    composer.pauseQueue(conversationId, "stopped");
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
      }, conversation, { requestId: item.id, agentPreset: isAgentPresetId(conversation.agentPreset) ? conversation.agentPreset : agentSettings.presetId });
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

  async function selectProvider(id: ProviderConnectionId) {
    const provider = activeProject.providers.connections.find((entry) => entry.id === id && entry.enabled);
    if (!provider) return;
    const nextProject = {
      ...activeProject,
      providers: { ...activeProject.providers, defaultProviderId: id },
    };
    setConfiguredProject((current) => ({
      ...current,
      providers: { ...current.providers, defaultProviderId: id },
    }));
    await synchronizePiRuntime(nextProject);
  }

  async function selectModel(model: string) {
    const provider = defaultProviderConnection(activeProject);
    const nextProvider = {
      ...provider,
      defaultModel: model,
      models: provider.models.includes(model) ? provider.models : [model, ...provider.models],
    };
    const nextProject = {
      ...activeProject,
      providers: {
        ...activeProject.providers,
        connections: activeProject.providers.connections.map((entry) => entry.id === provider.id ? nextProvider : entry),
      },
    };
    updateProvider(provider.id, { defaultModel: model });
    await synchronizePiRuntime(nextProject);
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
  async function startNewSession() {
    navigatedRef.current = true;
    // A run in flight keeps going in its own conversation; it only draws while on screen.
    const conversation = createEphemeralPiConversation();
    setStreamId("");
    setPiConversations((current) => replacePiConversation(current, conversation));
    // Set at once, not on the next render: a background run's frame must not draw over this view.
    activeConversationIdRef.current = conversation.id;
    setActivePiConversationId(conversation.id);
    setPiEvents([]);
    void startNewPiSession(conversation.id)
      .then(setPiRuntimeState)
      .then(() => synchronizePiRuntime(activeProject, conversation.id))
      .catch(() => undefined);
    setOutputPanelItems([]);
    setActiveOutputPanelItemId(undefined);
    setOutputModalOpen(false);
    setLeftCollapsed(false);
    // Collapsed, not opened: a fresh conversation has no output yet.
    setRightCollapsed(true);
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
  function startConversationWith(presetId: AgentPresetId) {
    navigatedRef.current = true;
    setDrawerOpen(false);
    const next = { ...agentSettings, presetId };
    setAgentSettings(next);
    saveAgentSettings(next);
    if (activePiConversation.events.length > 0 || piRunning || hasComposerState(composer.drafts[activePiConversationId])) void startNewSession();
  }

  function selectPiConversation(conversationId: string) {
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
    setOutputPanelItems([]);
    setActiveOutputPanelItemId(undefined);
    setOutputModalOpen(false);
    void synchronizePiRuntime(activeProject, conversation.id).catch(() => undefined);
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
    onModelChange: (model) => void selectModel(model),
    onApprovalDecision: approveLive,
    onCollapseLeft: () => setLeftCollapsed(true),
    onCollapseRight: () => setRightCollapsed(true),
    onOpenArtifact: openArtifact,
    outputPanelItems: liveOutputPanelItems,
    activeOutputPanelItemId,
    onSelectOutputPanelItem: setActiveOutputPanelItemId,
    onCloseOutputPanelItem: closeOutputPanelItem,
    onOutputSourceChange: setOutputSource,
    // Not a no-op: starting a new conversation needs no backend, it just clears the transcript
    // and returns to the welcome screen. Wiring it to `noop` made the button look broken —
    // the one control in the shell a user is guaranteed to try.
    onNewSession: startNewSession,
    // Each role greets in its own words; the configured greeting stays the fallback.
    welcomeGreeting: copy.composer.agentSettings.presets[agentSettings.presetId]?.greeting ?? activeProject.welcome.greeting,
    isWelcome,
    defaultPermissionMode: permissionDefault ?? piRuntimeState?.defaultPermissionMode,
    // Settings opens from the sidebar footer and the header, not from the composer.
    providerSettingsControl: undefined,
  };

  const defaultProvider = defaultProviderConnection(activeProject);
  const changeComposerDraft = (update: (draft: ComposerDraft) => ComposerDraft) => {
    const conversation = { ...activePiConversation, agentPreset: agentSettings.presetId };
    if (activePiConversation.agentPreset !== conversation.agentPreset) {
      setPiConversations(current => current.map(entry => entry.id === conversation.id ? { ...entry, agentPreset: conversation.agentPreset } : entry));
    }
    void composer.update(conversation, update);
  };
  // Every agent with a conversation in flight shows it, not only the one on screen.
  const agentStatuses: Partial<Record<AgentPresetId, AgentRunStatus>> = {};
  for (const conversation of piConversations) {
    if (!runningConversationIds.has(conversation.id) || !isAgentPresetId(conversation.agentPreset)) continue;
    const waiting = awaitingConversationIds.has(conversation.id) || Boolean(pendingUserInput(conversation.events))
      || (conversation.id === activePiConversationId && Boolean(liveApprovalTool));
    if (waiting) agentStatuses[conversation.agentPreset] = "needs-you";
    else agentStatuses[conversation.agentPreset] ??= "running";
  }
  const shellExtras: ShellExtras = {
    messageBranch,
    composerFocus: activePiConversationId === composerFocus ? composerFocus : undefined,
    transcriptScroll,
    agentSwitcher: (
      <AgentSwitcher
        avatars={PRESET_AVATARS}
        activeId={agentSettings.presetId}
        statuses={agentStatuses}
        harnesses={piRuntimeState?.harnesses}
        onSelect={startConversationWith}
      />
    ),
    sidebarFooter: <SidebarFooter onOpenSettings={() => openSettings("providers")} />,
    headerAgent: (
      <HeaderAgent
        avatars={PRESET_AVATARS}
        settings={agentSettings}
        providerLabel={`${defaultProvider.label} · ${defaultProvider.defaultModel}`}
        onChange={changeAgentSettings}
        onManageProviders={() => openSettings("providers")}
      />
    ),
    searchConversations: streamId ? undefined : searchConversations,
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
    composerPlaceholder: settingsCopy[locale].shell.messageTo(copy.composer.agentSettings.presets[agentSettings.presetId].name),
    stopStatus: !streamId && piRunning ? runStop.statusFor(activePiConversationId) : undefined,
    composerOptions: {
      value: {
        permissionMode: composer.drafts[activePiConversationId]?.runOptions?.permissionMode ?? permissionDefault ?? piRuntimeState?.defaultPermissionMode ?? "request",
        budgetMode: composer.drafts[activePiConversationId]?.runOptions?.budgetMode ?? "medium",
      },
      onChange: update => changeComposerDraft(current => ({ ...current, runOptions: { ...current.runOptions, ...update } })),
    },
    composerQueue: streamId ? undefined : {
      items: (composer.queues[activePiConversationId]?.items ?? []).map((item) => ({ id: item.id, prompt: queuedPrompt(item), attachmentCount: item.attachments.length })),
      paused: composer.queues[activePiConversationId]?.paused,
      canEnqueue: !acceptingConversationIds.has(activePiConversationId),
      canEdit: !hasComposerDraft(composer.drafts[activePiConversationId]),
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
    workspaceRevision: piRunning,
    workspaceSharedAvailable: Boolean(piRuntimeState?.workspace?.shared),
    workspace: piRuntimeState?.workspace,
    onOpenFile: openArtifact,
  };

  const previewOverlaySlots = renderSlots(
    visibleLayoutSlots.filter((slot) => slot.component === "OutputFrame"),
    "overlay",
    { ...slotContext, onCollapseRight: undefined },
  );

  const appearance = (themeTokens[themePreset] ?? Object.values(themeTokens)[0]).appearance;
  // Explicit opt-in even in dev: npm run dev is how recipients first inspect the package,
  // so debug chrome must not appear unless they ask for it with ?devtools=1.
  const showPicker = devtoolsRequested() && isFixtureMode && streams.length > 0;
  // String concat (not a template literal) so this file can be emitted from the exporter.
  const soloStack = (
    <section className="preview-stack preview-stack-solo" data-welcome={isWelcome ? "true" : undefined}>
      {renderSlots(visibleLayoutSlots, "main", slotContext)}
      {inlineApprovalOverlay}
      {userInputOverlay}
      {externalApprovalOverlay}
      {renderSlots(visibleLayoutSlots, "composer", slotContext)}
    </section>
  );
  const mainSize = activeProject.layout.mainSize + "%";
  const rightSize = activeProject.layout.rightPanelSize + "%";

  return (
    // No inline layout: `.exported-shell` shares `.builder-surface`'s rule in app.css,
    // which is the sizing context `.preview-frame` and `.preview-overlay-surface` were
    // designed against. Re-implementing it here is what made the export "not fit".
    <AgentPersonaProvider persona={persona}>
    <ShellExtrasProvider value={shellExtras}>
    <div className="exported-shell" style={{ height: "100dvh" }}>

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
                onClick={() => setDrawerOpen(true)}
              >
                <span className="native-rail-icon"><SidebarRailIcon size={17} /></span>
                <span className="legacy-rail-icon"><PanelLeft size={17} /></span>
              </button>
              <div className="compact-drawer-scrim" data-open={drawerOpen} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
              <div className="compact-drawer" data-open={drawerOpen} inert={!drawerOpen}>
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
              aria-label={copy.shell.editor.expandPanel}
              onClick={() => autoHiddenRails.right ? setWorkspaceModalOpen(true) : setRightCollapsed(false)}
            >
              <span className="native-rail-icon"><RightSidebarRailIcon size={15} /></span>
              <span className="legacy-rail-icon"><PanelRight size={15} /></span>
            </button>
          ) : null}
          {workspaceModalOpen ? (
            <Suspense fallback={null}>
              <OutputFrame project={activeProject} viewModel={displayViewModel} fullscreen onCollapse={() => setWorkspaceModalOpen(false)} />
            </Suspense>
          ) : null}
          {outputModalOpen ? (
            <Suspense fallback={null}>
              <OutputPanelModal
                items={liveOutputPanelItems}
                activeId={activeOutputPanelItemId}
                onSelectItem={setActiveOutputPanelItemId}
                onCloseItem={closeOutputPanelItem}
                onClose={() => setOutputModalOpen(false)}
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
        </div>
      ) : null}
    </div>
        {settingsMounted ? (
          <Suspense fallback={null}>
            <SettingsDialog
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              initialSection={settingsSection}
            project={activeProject}
            providerSettingsStatus={providerSettingsStatus}
            runtime={piRuntimeState}
            isRunning={piRunning}
            sessionKeys={sessionKeys}
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
            onThemeChange={(id) => {
              setThemePreset(id);
              storeSetting(THEME_KEY, id);
            }}
            imChannels={piRuntimeState ? imChannels : undefined}
            />
          </Suspense>
        ) : null}
    </ShellExtrasProvider>
    </AgentPersonaProvider>
  );
}
