import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { useAgentUXReplay } from "@agent-ux/react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { PanelLeft, PanelRight } from "lucide-react";

import {
  OutputPanelModal,
  normalizeOutputPanelRequest,
  type OutputPanelItem,
  type OutputPanelOpenRequest,
} from "./components/agent-preview/OutputFrame";
import { SettingsDialog, type SettingsSectionId } from "./components/settings/SettingsDialog";
import { AgentSwitcher, HeaderAgent, ShellExtrasProvider, SidebarFooter, type AgentRunStatus, type ShellExtras } from "./components/shell/ShellExtras";
import { settingsCopy } from "./i18n/copy/settings";
import type { ComposerSubmitContext } from "./components/agent-preview/ComposerFrame";
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
  abortPiRun,
  configurePiRuntime,
  getPiRuntimeState,
  getStoredConversation,
  listStoredConversations,
  resolvePiApproval,
  runPiTurn,
  startNewPiSession,
  type PiRuntimeState,
} from "./pi/piClient";
import { piRuntimeConfigurationForProvider } from "./pi/piProviderSync";
import { isAgentPresetId, loadAgentSettings, saveAgentSettings, settingsUseProvider, type AgentPresetId, type AgentSettings } from "./pi/harnessCatalog";
import { AgentPersonaProvider, type AgentPersona, type AvatarKind } from "./avatars/AgentPersona";

const THEME_KEY = "raytonebot.theme";
/** Events after which a tool call is no longer waiting on the user. */
const APPROVAL_SETTLED_EVENTS = new Set(["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished", "run.finished"]);
const PERMISSION_DEFAULT_KEY = "raytonebot.permissionDefault";

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
import { piErrorTurnEvents } from "./pi/piErrorTurn";
import { piCancelledTurnEvents } from "./pi/piCancelledTurn";
import { createPiFrameCommit } from "./pi/piFrameCommit";

const noop = () => {};
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
  // Closed until asked for, matching the configurator: a run with nothing to show should not
  // hand half the canvas to an empty output panel. Opens on the drawer toggle or on clicking an
  // artifact in the conversation.
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [autoHiddenRails, setAutoHiddenRails] = useState({ left: false, right: false });
  const [outputPanelItems, setOutputPanelItems] = useState<OutputPanelItem[]>([]);
  const [activeOutputPanelItemId, setActiveOutputPanelItemId] = useState<string | undefined>(undefined);
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [outputSource, setOutputSource] = useState(project.output.source);
  const [sessionKeys, setSessionKeys] = useState<Record<string, string>>({});
  const [configuredProject, setConfiguredProject] = useState(project);
  const [piEvents, setPiEvents] = useState<AgentUXEvent[] | undefined>(undefined);
  const [piConversations, setPiConversations] = useState<readonly EphemeralPiConversation[]>(() => [
    createEphemeralPiConversation(),
  ]);
  const [activePiConversationId, setActivePiConversationId] = useState(() => piConversations[0].id);
  /** Conversations with a turn in flight. Each runs on its own; switching away does not stop it. */
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Running conversations currently held on a tool approval, including ones not on screen. */
  const [awaitingConversationIds, setAwaitingConversationIds] = useState<ReadonlySet<string>>(() => new Set());
  const piRunning = runningConversationIds.has(activePiConversationId);
  const [piRuntimeState, setPiRuntimeState] = useState<PiRuntimeState>();
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(loadAgentSettings);
  const [celebrating, setCelebrating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("providers");
  const openSettings = (section: SettingsSectionId = "providers") => {
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
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | null>(null);
  const piAbortRefs = useRef(new Map<string, AbortController>());

  // Single entry for both modes: fixture replay (dev/preview) or the live backend
  // stream. Components never learn which one they got.
  const { events: sourceEvents, streams, streamId, setStreamId } = useEventSource();
  const events = piEvents ?? sourceEvents;
  const activePiConversation = useMemo(
    () => piConversations.find((conversation) => conversation.id === activePiConversationId) ?? piConversations[0],
    [activePiConversationId, piConversations],
  );
  const piSessionItems = useMemo(
    () => piConversationSidebarItems(piConversations.filter((conversation) => conversation.events.length > 0 || conversation.stored)),
    [piConversations],
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
  const { viewModel } = useAgentUXReplay(events, {
    policy: {
      reasoning: reasoningRenderPolicy,
      tool: toolRenderPolicy,
      error: { showDeveloperMessage: !project.blocks.errorCollapse, showRawError: false },
      visibility: { show: "developer" },
    },
  });
  const displayViewModel = useMemo(() => localizePreviewViewModel(viewModel, locale), [locale, viewModel]);
  const isWelcome = displayViewModel.timeline.length === 0;

  const activeProject = useMemo(
    () => ({ ...configuredProject, output: { ...configuredProject.output, source: outputSource } }),
    [configuredProject, outputSource],
  );
  // Both approval modes answer above the composer, exactly where the configurator previewed
  // them. Each mode needs its own surface here: `ChatFrame` no longer places either one in the
  // transcript, so a mode without an overlay would leave a real run with nothing to click.
  const pendingApprovalTool = displayViewModel.timeline.find((item): item is AgentUXToolTimelineItem =>
    item.kind === "tool" && item.status === "awaiting_approval" && Boolean(item.approval),
  );
  const liveApprovalTool = pendingApprovalTool && pendingApprovalTool.id !== dismissedApprovalId
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
    state: liveApprovalTool ? "warning" : piRunning ? "waiting" : celebrating ? "success" : "idle",
  };
  const approveLive = async (toolCallId: string, decision: ApprovalDecision) => {
    try {
      await resolvePiApproval(toolCallId, decision);
    } finally {
      // Dismiss whether or not the decision landed: a stopped run answers 409, and leaving
      // the overlay up would strand it on a tool that can never be answered.
      setDismissedApprovalId(toolCallId);
    }
  };
  const inlineApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "inline" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay" data-approval-kind="inline-runtime">
      <InlineApprovalSurface
        key={liveApprovalTool.id}
        tool={liveApprovalTool}
        onConfirm={(decision) => approveLive(liveApprovalTool.id, decision)}
      />
    </div>
  ) : null;
  const externalApprovalOverlay = liveApprovalTool && activeProject.toolCalls.approval === "hidden" ? (
    <div className="preview-approval-overlay" data-preview-region="approval-overlay">
      <ExternalApprovalSurface
        key={liveApprovalTool.id}
        tool={liveApprovalTool}
        onConfirm={(decision) => approveLive(liveApprovalTool.id, decision)}
      />
    </div>
  ) : null;

  const activeConversationIdRef = useRef(activePiConversationId);
  activeConversationIdRef.current = activePiConversationId;

  // Conversations saved by the host (earlier visits, other browsers, before a restart) appear in
  // the sidebar at once; their transcripts load when opened.
  useEffect(() => {
    void listStoredConversations()
      .then((stored) => {
        setPiConversations((current) => {
          const known = new Set(current.map((entry) => entry.id));
          const stubs = stored
            .filter((entry) => entry.eventCount > 0 && !known.has(entry.id))
            .map((entry) => ({
              id: entry.id,
              title: entry.title,
              createdAt: entry.createdAt,
              agentPreset: entry.agentPreset,
              events: [],
              stored: true,
            }));
          return [...current, ...stubs];
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const provider = defaultProviderConnection(project);
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
  const leftSidebarVisible = leftSidebarMounted && !leftCollapsed;
  // Available = it could be shown. Visible = the reader has opened it. Clicking an artifact
  // keys on the former, so a collapsed panel reopens instead of being bypassed for a modal.
  const rightPanelAvailable = hasRightPanel && !autoHiddenRails.right && !isWelcome;
  const rightPanelVisible = rightPanelAvailable && !rightCollapsed;

  function openArtifact(request: OutputPanelOpenRequest) {
    const item = normalizeOutputPanelRequest(request);
    setOutputPanelItems((current) => {
      const index = current.findIndex((entry) => entry.id === item.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = item;
        return next;
      }
      return [...current, item];
    });
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
  ) {
    const provider = defaultProviderConnection(projectSnapshot);
    const state = await configurePiRuntime(
      {
        ...piRuntimeConfigurationForProvider(provider, sessionKeys[provider.id]),
        conversationId,
      },
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

  /** Adds or removes one conversation from a set held in state. */
  const toggleIn = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    if (set.has(id) === on) return set;
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  async function submitToPi(prompt: string, context?: ComposerSubmitContext) {
    if (piRunning) return;
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;
    let nextConversation: EphemeralPiConversation = {
      ...titlePiConversation(activePiConversation, normalizedPrompt),
      agentPreset: agentSettings.presetId,
    };
    const conversationId = nextConversation.id;
    const turnStartEventCount = nextConversation.events.length;
    const provider = defaultProviderConnection(activeProject);
    const controller = new AbortController();
    piAbortRefs.current.set(conversationId, controller);
    setRunningConversationIds((current) => toggleIn(current, conversationId, true));
    // The run keeps going when the user opens another conversation; only the one on screen is drawn.
    const showIfActive = (conversation: EphemeralPiConversation) => {
      if (activeConversationIdRef.current === conversation.id) setPiEvents([...conversation.events]);
    };
    setPiConversations((current) => replacePiConversation(current, nextConversation));
    showIfActive(nextConversation);
    const runId = "pi_export_" + Date.now().toString(36);
    // Same coalescing as the configurator, from the same module, so a long reply does not slow
    // down as it grows here either. The conversation is still appended one event at a time.
    const commit = createPiFrameCommit<EphemeralPiConversation>((conversation) => {
      setPiConversations((current) => replacePiConversation(current, conversation));
      showIfActive(conversation);
    });
    try {
      // Codex and a locally logged-in Claude Code bring their own model; only roles that run
      // on the configured model service need it registered (and its key handed over) first.
      if (settingsUseProvider(agentSettings)) await synchronizePiRuntime(activeProject, nextConversation.id);
      for await (const event of runPiTurn({
        conversationId: nextConversation.id,
        prompt: normalizedPrompt,
        provider: provider.id,
        model: provider.defaultModel,
        thinkingLevel: context?.budgetMode === "fast" ? "low" : context?.budgetMode === "expert" ? "high" : "medium",
        permissionMode: context?.permissionMode ?? "request",
        agentPreset: agentSettings.presetId,
        claudeCodeModelSource: agentSettings.claudeCodeModelSource,
        codexModelSource: agentSettings.codexModelSource,
      }, { signal: controller.signal })) {
        if (controller.signal.aborted || piAbortRefs.current.get(conversationId) !== controller) {
          commit.cancel();
          return;
        }
        nextConversation = appendPiConversationEvents(nextConversation, [event]);
        commit.push(nextConversation);
        if (event.type === "tool.call.awaiting_approval") {
          // Waiting on the user, so it cannot wait on a frame.
          commit.flush();
          setAwaitingConversationIds((current) => toggleIn(current, conversationId, true));
        } else if (APPROVAL_SETTLED_EVENTS.has(event.type)) {
          setAwaitingConversationIds((current) => toggleIn(current, conversationId, false));
        }
      }
      commit.flush();
      await refreshPiRuntime();
    } catch (error) {
      // Cancelled, not flushed: a frame still queued holds the conversation as it was *before*
      // the error events were appended, and letting it land after the commit below would erase
      // them from the screen.
      commit.cancel();
      if (controller.signal.aborted) {
        // The abort severed the stream, so the server's own wrap-up events never arrive.
        // Close whatever is still open locally (text/tool/reasoning blocks + a cancelled
        // run terminal) so the transcript never keeps a half-finished turn.
        const closed = appendPiConversationEvents(nextConversation, piCancelledTurnEvents(nextConversation.events));
        setPiConversations((current) => replacePiConversation(current, closed));
        showIfActive(closed);
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
      if (piAbortRefs.current.get(conversationId) === controller) piAbortRefs.current.delete(conversationId);
      setRunningConversationIds((current) => toggleIn(current, conversationId, false));
      setAwaitingConversationIds((current) => toggleIn(current, conversationId, false));
    }
  }

  /** Stops the conversation on screen; runs in other conversations continue. */
  async function stopPi(conversationId = activePiConversationId) {
    piAbortRefs.current.get(conversationId)?.abort();
    try {
      await abortPiRun(conversationId);
    } catch {
      // Server-side abort is best effort; the local state below is what matters.
    }
    setRunningConversationIds((current) => toggleIn(current, conversationId, false));
    setAwaitingConversationIds((current) => toggleIn(current, conversationId, false));
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
    const presetChanged = next.presetId !== agentSettings.presetId;
    setAgentSettings(next);
    saveAgentSettings(next);
    if (presetChanged && activePiConversation.events.length > 0) void startNewSession();
  }

  /** Clicking an agent is how a new conversation starts (there is no separate "new chat" button).
   *  An empty conversation on screen is reused rather than stacking another blank one. */
  function startConversationWith(presetId: AgentPresetId) {
    const next = { ...agentSettings, presetId };
    setAgentSettings(next);
    saveAgentSettings(next);
    if (activePiConversation.events.length > 0 || piRunning) void startNewSession();
  }

  function selectPiConversation(conversationId: string) {
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
    if (conversation.stored && conversation.events.length === 0) {
      void getStoredConversation(conversation.id)
        .then((stored) => {
          const loaded = { ...conversation, title: stored.title, events: stored.events, stored: false };
          setPiConversations((current) => current.map((entry) => (entry.id === loaded.id ? loaded : entry)));
          if (activeConversationIdRef.current === loaded.id) setPiEvents([...stored.events]);
        })
        .catch(() => undefined);
    }
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
    onApprovalDecision: (toolCallId, decision) => resolvePiApproval(toolCallId, decision),
    onCollapseLeft: () => setLeftCollapsed(true),
    onCollapseRight: () => setRightCollapsed(true),
    onOpenArtifact: openArtifact,
    outputPanelItems,
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
  // Every agent with a conversation in flight shows it, not only the one on screen.
  const agentStatuses: Partial<Record<AgentPresetId, AgentRunStatus>> = {};
  for (const conversation of piConversations) {
    if (!runningConversationIds.has(conversation.id) || !isAgentPresetId(conversation.agentPreset)) continue;
    const waiting = awaitingConversationIds.has(conversation.id)
      || (conversation.id === activePiConversationId && Boolean(liveApprovalTool));
    if (waiting) agentStatuses[conversation.agentPreset] = "needs-you";
    else agentStatuses[conversation.agentPreset] ??= "running";
  }
  const shellExtras: ShellExtras = {
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
    sessionAvatars: Object.fromEntries(
      piConversations.flatMap((conversation) => (
        isAgentPresetId(conversation.agentPreset) ? [[conversation.id, PRESET_AVATARS[conversation.agentPreset]]] : []
      )),
    ),
    composerPlaceholder: settingsCopy[locale].shell.messageTo(copy.composer.agentSettings.presets[agentSettings.presetId].name),
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
  const mainSize = activeProject.layout.mainSize + "%";
  const rightSize = activeProject.layout.rightPanelSize + "%";

  return (
    // No inline layout: `.exported-shell` shares `.builder-surface`'s rule in app.css,
    // which is the sizing context `.preview-frame` and `.preview-overlay-surface` were
    // designed against. Re-implementing it here is what made the export "not fit".
    <AgentPersonaProvider persona={persona}>
    <ShellExtrasProvider value={shellExtras}>
    <div className="exported-shell" style={{ height: "100vh" }}>

      <>
        <div
          className="preview-frame"
          data-has-sidebar={hasSidebar}
          data-has-right-panel={rightPanelVisible}
          data-left-collapsed={leftCollapsed}
          data-right-collapsed={rightCollapsed}
          data-style-preset={project.theme.stylePreset}
          data-appearance={appearance}
          ref={frameRef}
        >
          {leftSidebarMounted ? renderSlots(visibleLayoutSlots, "sidebar", slotContext) : null}
          {rightPanelVisible ? (
            <PanelGroup className="preview-panels" orientation="horizontal">
              <Panel defaultSize={mainSize} minSize="52%">
                <section className="preview-stack" data-welcome={isWelcome ? "true" : undefined}>
                  {renderSlots(visibleLayoutSlots, "main", slotContext)}
                  {inlineApprovalOverlay}
                  {externalApprovalOverlay}
                  {renderSlots(visibleLayoutSlots, "composer", slotContext)}
                </section>
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={rightSize} minSize="24%">
                <aside className="right-panel">
                  {renderSlots(visibleLayoutSlots, "right-panel", slotContext)}
                </aside>
              </Panel>
            </PanelGroup>
          ) : (
            <section className="preview-stack preview-stack-solo" data-welcome={isWelcome ? "true" : undefined}>
              {renderSlots(visibleLayoutSlots, "main", slotContext)}
              {inlineApprovalOverlay}
              {externalApprovalOverlay}
              {renderSlots(visibleLayoutSlots, "composer", slotContext)}
            </section>
          )}
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
          {hasRightPanel && rightCollapsed && !autoHiddenRails.right && !isWelcome ? (
            <button
              type="button"
              className="rail-icon-btn preview-rail-float"
              data-side="right"
              aria-label={copy.shell.editor.expandPanel}
              onClick={() => setRightCollapsed(false)}
            >
              <span className="native-rail-icon"><RightSidebarRailIcon size={15} /></span>
              <span className="legacy-rail-icon"><PanelRight size={15} /></span>
            </button>
          ) : null}
          {outputModalOpen ? (
            <OutputPanelModal
              items={outputPanelItems}
              activeId={activeOutputPanelItemId}
              onSelectItem={setActiveOutputPanelItemId}
              onCloseItem={closeOutputPanelItem}
              onClose={() => setOutputModalOpen(false)}
            />
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
            onValueChange={setStreamId}
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
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialSection={settingsSection}
        project={activeProject}
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
        />
    </ShellExtrasProvider>
    </AgentPersonaProvider>
  );
}
