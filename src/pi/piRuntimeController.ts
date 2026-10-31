import { asRecord, errorMessage, normalizeConversationId } from "./piHostUtils.ts";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  createPiEventAdapter,
  type PiApprovalDecision,
  type PiEventAdapter,
  type PiWireEvent,
} from "../harness/adapters/piAdapter.ts";
import { vaultResultMessage } from "../i18n/copy/vaultRequest.ts";
import { validArtifactSubmission } from "../runtime/artifactForm.ts";
import type { PendingUserInput, UserAnswers } from "../runtime/userInput.ts";
import { PiApprovalGate, type PiPermissionMode } from "./approvalGate.ts";
import { ApprovalMemory } from "./approvalMemory.ts";
import { artifactTools } from "./artifactTool.ts";
import { ArtifactVersionStore } from "./artifactVersions.ts";
import { BotConfigStore } from "./botConfig.ts";
import { createBotSkillsService } from "./botSkills.ts";
import { type BrowserService } from "./browser/browserService.ts";
import { lastClaudeTaskPlan } from "./claudeTaskPlan.ts";
import { detectCliHarnesses, runClaudeCode, runCodex } from "./cliHarness.ts";
import { ConversationBranchError, type NativeTurnCheckpoint } from "./conversationBranch.ts";
import { createConversationHistoryTools } from "./conversationHistoryTools.ts";
import { createConversationRecorder } from "./conversationRecorder.ts";
import { conversationReferenceNote, conversationReferences } from "./conversationReferences.ts";
import { ConversationRequestError } from "./conversationRequestError.ts";
import {
  createConversationStore,
  defaultDataDir,
  type ConversationStore,
  type ConversationSummary,
  type StoredConversation,
} from "./conversationStore.ts";
import { summarizeConversationTitle } from "./conversationTitle.ts";
import { runDsh } from "./dshHarness.ts";
import { attachGroupChat, type GroupController } from "./groupChat.ts";
import { resolveBotIdentity } from "./groupParticipants.ts";
import {
  agentPreset,
  anthropicBaseUrlForProvider,
  isAgentPresetId,
  settingsUseProvider,
  type AgentHarnessId,
  type AgentPresetId,
} from "./harnessCatalog.ts";
import { runLimits, runtimeLogger, type RunLimits } from "./hostOperations.ts";
import { type ChannelSetupResult, type ChannelSetupRun } from "./imChannels/channelSetup.ts";
import type { ChannelSetupRequest } from "./imChannels/connectChannelTool.ts";
import { redactCredentials } from "./imChannels/redactCredentials.ts";
import { reviewLearning } from "./learning/review.ts";
import { createLearningService, learningEvidence } from "./learning/service.ts";
import { type McpToolkit } from "./mcpServers.ts";
import { mergeHostTools, type HostTools, type MemoryService } from "./memories.ts";
import { defaultProtectedPaths, defaultReadOnlyPaths, defaultSecretPaths } from "./permissionPolicy.ts";
import { piCancelledTurnEvents } from "./piCancelledTurn.ts";
import {
  type PiPromptInput,
  type PiProviderDefinition,
  type PiRuntimeConfiguration,
  type PiRuntimeState
} from "./piClient.ts";
import { piErrorTurnEvents } from "./piErrorTurn.ts";
import { piRuntimeConfigurationForProvider } from "./piProviderSync.ts";
import { createDefaultPiBridge, type PiSessionBridge } from "./piSdkBridge.ts";
import { probeProvider, type ProviderProbeResult } from "./providerProbe.ts";
import { providerBinding, ProviderStore } from "./providerStore.ts";
import { rolePrompt, withConversationContext, withReplyLanguage, withUnseenPrompts } from "./rolePrompt.ts";
import { type RoutineCreateInput, type RoutineRequest } from "./routines.ts";
import type { RoutineView } from "./routineTypes.ts";
import { requireAgentIsolation } from "./runtime/agentProcess.ts";
import { createModelGateway } from "./runtime/modelGateway.ts";
import { createRunDeadline } from "./runtime/runDeadline.ts";
import { createUsageService } from "./usage.ts";
import type { UsageState } from "./usageTypes.ts";
import { UserInputGate } from "./userInputGate.ts";
import type { UserInputRequest } from "./userInputTool.ts";
import { VaultStore } from "./vault.ts";
import { VaultRequestGate } from "./vaultRequests.ts";
import type { VaultUseResult } from "./vaultRequestTypes.ts";
import { vaultToolsFor } from "./vaultUse.ts";
import { createWebTools } from "./webAccess.ts";
import { promptWithWorkspaceFiles, saveWorkspaceDownload } from "./workspaceFiles.ts";
import { resolveWorkspaceLayout, type WorkspaceLayout } from "./workspaceLayout.ts";



export type PiBridgeFactory = (input: {
  cwd: string;
  approvalGate: PiApprovalGate;
  /** Where this conversation's Pi session lives on disk; in memory when omitted. */
  sessionDir?: string;
  onUserInput(request: UserInputRequest): Promise<UserAnswers>;
  delegated?: boolean;
  hostTools?: HostTools;
  /** `connect_channel`: absent when the host has no channel setup (tests, previews). */
  onChannelSetup?(request: ChannelSetupRequest): Promise<ChannelSetupResult>;
  /** `create_routine`: absent when the host keeps no routines (tests, previews). */
  onCreateRoutine?(request: RoutineRequest): Promise<RoutineView>;
}) => Promise<PiSessionBridge>;

export type PiRuntimeController = {
  readonly artifactVersions: ArtifactVersionStore;
  learning: ReturnType<typeof createLearningService>;
  usage(): UsageState;
  /** Permission mode a turn gets when its client does not choose one (IM channels). */
  readonly defaultPermissionMode: PiPermissionMode;
  health(): { status: "ok"; activeRuns: number; maxConcurrentRuns: number; uptimeSeconds: number; lastRunAgoMs?: number };
  state(conversationId?: string): Promise<PiRuntimeState>;
  configure(input: PiRuntimeConfiguration): Promise<PiRuntimeState>;
  /** `signal` belongs to the caller's stream: aborting it stops this run, and only once the run
   *  holds its slot (a rejected duplicate must not stop the turn already in progress).
   *  `fromChannel` marks a turn sent from an IM chat, which cannot show browser cards.
   *  Internal group children may `waitForCapacity`; cancelling that wait leaves no receipt.
   *  `title` names a new conversation instead of its first prompt (a routine's own name). */
  runPrompt(input: PiPromptInput, onEvent: (event: AgentUXEvent) => void, options?: { signal?: AbortSignal; fromChannel?: boolean; waitForCapacity?: boolean; title?: string; groupConversation?: boolean; groupId?: string; publicRunId?: string; delegated?: boolean; extraHostTools?: import("./memories.ts").HostTools; readOnly?: boolean }): Promise<void>;
  /** Stops one conversation's run; every run when no conversation is given. */
  abort(conversationId?: string, runId?: string): Promise<boolean>;
  steer(conversationId: string, runId: string, requestId: string, text: string): Promise<boolean>;
  testProvider(definition: PiProviderDefinition, apiKey?: string): Promise<ProviderProbeResult>;
  refreshProviders?(): void;
  /** Saved conversations; `running` marks those with a turn in flight right now, `awaitingUser`
   *  those whose turn holds an approval or a question for the user. */
  listConversations(query?: string): (ConversationSummary & { running: boolean; activeRunId?: string; awaitingUser?: boolean })[];
  /** The conversation's turn waits on the user (an approval or a question), e.g. an unattended routine. */
  awaitingUser(conversationId: string): boolean;
  conversationReadErrors(): string[];
  /**
   * Watch a run in flight from event `after` on: the saved events past it first, then live ones.
   * `undefined` when the conversation has nothing running. A watcher leaving never stops the run.
   */
  followRun(conversationId: string, after: number, onEvent: (event: AgentUXEvent) => void): { done: Promise<void>; stop(): void } | undefined;
  registerDocument(id: string, document: NonNullable<StoredConversation["documents"]>[number]): void;
  getConversation(id: string): (StoredConversation & { incomplete: boolean; activeRunId?: string }) | undefined;
  deleteConversation(id: string): void;
  /** Saves a hand-written title; undefined when there is no such conversation. */
  renameConversation(id: string, title: string): string | undefined;
  branchConversation(id: string, beforeRunId: string): ReturnType<ConversationStore["branch"]>;
  /** Answers a held tool call; with a conversation, only that conversation's gate is consulted. */
  resolveApproval(toolCallId: string, decision: PiApprovalDecision, conversationId?: string, runId?: string): boolean;
  hasApproval(toolCallId: string, conversationId: string, runId: string): boolean;
  resolveUserInput(conversationId: string, requestId: string, answers: unknown): boolean;
  resolveVaultInput?(conversationId: string, requestId: string, runId: string, answer: unknown): Promise<VaultUseResult>;
  newSession(conversationId?: string): Promise<PiRuntimeState>;
  /** Forgets "always allow" grants: one agent's, or every agent's. */
  clearApprovals(agentPreset?: string): Record<string, string[]>;
  /** MCP servers changed: Pi sessions reopen with the new tools, a running one after its run. */
  refreshTools(): void;
  dispose(): void;
};

function artifactPath(cwd: string, path: string): string {
  const absolute = resolvePath(cwd, path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function createPiRuntimeController(options: {
  cwd: string;
  /** Where the bot's own code lives; protected when the agent works elsewhere. */
  appRoot?: string;
  /** Running inside a disposable sandbox VM: generous defaults are safe. */
  sandboxed?: boolean;
  layout?: WorkspaceLayout;
  /** Conversations and Pi sessions on disk. Default: ~/.raytonebot/data. */
  dataDir?: string;
  store?: ConversationStore;
  bots?: BotConfigStore;
  providers?: ProviderStore;
  vault?: VaultStore;
  vaultDir?: string;
  bridgeFactory?: PiBridgeFactory;
  limits?: RunLimits;
  /** Connecting an IM channel from chat; the host binds it to its channel manager. */
  channelSetup?: (run: ChannelSetupRun) => Promise<ChannelSetupResult>;
  /** Saving a routine from chat; the host binds it to its routine service. */
  createRoutine?: (input: RoutineCreateInput) => RoutineView;
  /** The enabled MCP servers' tools now (ADR-037); read when a run or Pi session starts. */
  mcpTools?: (botId?: string) => McpToolkit | undefined;
  /** Cross-conversation memory (ADR-038): its note joins a turn's prompt, its tools each run. */
  memory?: MemoryService;
  skills?: ReturnType<typeof createBotSkillsService>;
  /** The shared browser (ADR-040): its tools each run, its snapshot judges each action. */
  browser?: BrowserService;
  /** Host-owned explicit delivery snapshots; tests may inject a temporary store. */
  artifactVersions?: ArtifactVersionStore;
}): GroupController {
  const { cwd } = options;
  const botConfig = options.bots;
  const dataDir = options.dataDir ?? defaultDataDir();
  const store = options.store ?? createConversationStore(dataDir);
  const usage = createUsageService({ dataDir });
  const artifactVersions = options.artifactVersions ?? new ArtifactVersionStore(`${dataDir}.artifact-versions`);
  const learning = createLearningService({ dataDir, busy: () => runs.size > 0 });
  const limits = options.limits ?? runLimits();
  const log = runtimeLogger(dataDir);
  /** `runPrompt` has its own `options`; services are read through these names. */
  const memory = options.memory;
  const optionsSkills = options.skills;
  const browser = options.browser;
  const startedAt = Date.now();
  // A turn still open on disk was cut off when the last process ended (restart, crash, redeploy).
  // It is closed as interrupted and never replayed: replaying could repeat writes or outward calls.
  for (const summary of store.list()) {
    const saved = store.get(summary.id);
    const closing = saved ? piCancelledTurnEvents(saved.events) : [];
    if (closing.length === 0) continue;
    for (const event of closing) store.append(summary.id, event);
    try { store.flush(summary.id); } catch {
      // Keep other conversations available. getConversation reports the missing terminal
      // without pretending this interruption marker was persisted to the failed disk.
    }
  }
  /** Per-role directories plus the shared one; one directory for everything when unset. */
  const layout = options.layout ?? resolveWorkspaceLayout({ fallbackCwd: cwd });
  const sandboxed = options.sandboxed ?? process.env.RAYTONEBOT_SANDBOX === "1";
  const defaultPermissionMode: PiPermissionMode = sandboxed ? "auto" : "request";
  const workspaces = [...new Set([cwd, ...Object.values(layout.agents), ...(layout.shared ? [layout.shared] : [])])];
  const appRoot = options.appRoot ?? process.cwd();
  const vaultDir = options.vaultDir ?? `${dataDir}.vault`;
  const privatePaths = [dataDir, `${dataDir}.provider-secrets`, vaultDir, artifactVersions.root];
  const secretPaths = [...defaultSecretPaths(), `${dataDir}.provider-secrets`, vaultDir, artifactVersions.root];
  // In the sandbox agents run as their own user with their own home; locally it is the developer's.
  const protectedPaths = defaultProtectedPaths({ workspaces, agentHome: process.env.RAYTONEBOT_AGENT_HOME?.trim() || undefined });
  /** The bot's own code: agents may read it (reviewing it is a normal task), never change it. */
  const readOnlyPaths = defaultReadOnlyPaths({ appRoot, workspaces });
  /** "Always allow" grants per agent, shared by every conversation with that agent. */
  const approvalMemory = new ApprovalMemory(join(dataDir, "approvals.json"));
  /** One gate per conversation: runs in different conversations wait on their own approvals,
   *  with their own mode and cwd. */
  const approvalGates = new Map<string, PiApprovalGate>();
  const userInputGate = new UserInputGate();
  const vaultRequests = new VaultRequestGate();
  const gateFor = (conversationId: string) => {
    let gate = approvalGates.get(conversationId);
    if (!gate) {
      gate = new PiApprovalGate({ cwd, secretPaths, protectedPaths, readOnlyPaths, egressContained: sandboxed,
        hostCall: options.browser ? (name, args) => options.browser!.classify(name, args) : undefined }, approvalMemory,
        () => runs.get(conversationId)?.deadline?.setPaused(Boolean(gate?.waiting)));
      approvalGates.set(conversationId, gate);
    }
    return gate;
  };
  const awaitingUser = (conversationId: string) => Boolean(approvalGates.get(conversationId)?.waiting) || userInputGate.waitingIn(conversationId) || vaultRequests.waitingIn(conversationId);
  /** Search and page reads, performed by the bot for every engine (agents have no egress). */
  const webTools = createWebTools({ proxyFakeIp: !sandboxed });
  let gatewayPromise: ReturnType<typeof createModelGateway> | undefined;
  const gateway = () => gatewayPromise ??= createModelGateway({ port: sandboxed ? undefined : 0 });
  const modelLease = async (provider: { baseUrl: string; apiKey: string; model: string }, protocol: "openai" | "anthropic", conversationId: string, thinkingLevel?: string) => {
    // Local gateways existed before Linux isolation; retain that development path. Only HTTPS
    // provider runs use this proxy and its request cap. Sandbox tasks never take this fallback.
    if (!sandboxed && new URL(provider.baseUrl).protocol === "http:") return { ...provider, revoke() {} };
    const slot = runs.get(conversationId);
    const lease = (await gateway()).issue({ ...provider, protocol, thinkingLevel, maxRequests: limits.modelRequests, maxDurationMs: limits.durationMs,
      remainingMs: slot?.deadline?.remainingMs,
      onUsage(requestId, measured) { if (slot) usage.record(slot.runId, requestId, measured, conversationId); },
      onLimit(message) {
        if (!slot || slot.limit) return;
        slot.limit = message;
        log("run.limit", { conversationId, limit: "modelRequests" });
        slot.adapter?.apply({ type: "extension_error", message });
        void abortRuns(conversationId, slot.runId).catch(() => undefined);
      },
    });
    return { ...provider, ...lease };
  };
  const bridgeFactory = options.bridgeFactory ?? ((input) => {
    const id = decodeURIComponent(input.sessionDir!.split("/").pop()!);
    const saved = store.get(id);
    return createDefaultPiBridge({ ...input, sandboxed, rolePrompt: rolePrompt(saved?.agentPreset ?? "assistant", layout, { sandboxed, botId: saved?.botId, availableBots: saved?.availableBots, profile: botConfig?.require(saved?.botId ?? saved?.agentPreset ?? "assistant") }), sessionId: saved?.piSessionId,
      branch: saved?.branch?.native?.harness === "pi" ? { ...saved.branch.native,
        sessionDir: join(dataDir, "pi-sessions", encodeURIComponent(saved.branch.native.sourceId)) } : undefined,
      hasHistory: saved?.agentPreset === "assistant" && saved.events.length > 0,
      onSessionId: (sessionId, beforeEntryId) => {
        const runId = runs.get(id)?.runId;
        if (runId) store.saveNativeTurn(id, runId, { harness: "pi", sessionId, sourceId: id, beforeEntryId });
        else store.setPiSession(id, sessionId);
      },
      onPromptAccepted: () => runs.get(id)?.memoryDelivered?.(),
      modelLease: (provider, protocol, thinkingLevel) => modelLease(provider, protocol, id, thinkingLevel),
      webTools,
      mcpTools: runs.get(id)?.delegated ? undefined : options.mcpTools?.(saved?.botId ?? saved?.agentPreset),
      hostTools: input.hostTools,
    });
  });
  /** Pi sessions opened with an older MCP tool list, closed when their run ends. */
  const staleBridges = new Set<string>();
  const dropBridge = (id: string) => {
    const bridge = bridgePromises.get(id);
    bridgePromises.delete(id);
    bridgeToolContexts.delete(id);
    void bridge?.then((current) => current.dispose(), () => undefined);
  };
  const bridgePromises = new Map<string, Promise<PiSessionBridge>>();
  const bridgeToolContexts = new Map<string, string>();
  /** Conversations that have already announced their tool set — see `runPrompt`. */
  const announcedCapabilities = new Set<string>();
  const defaultConversationId = "default";
  const maxConversations = 12;
  /** Runs in flight, one per conversation at most. The sandbox has 2 CPUs, so cap the total. */
  const maxConcurrentRuns = 3;
  type RunSlot = {
    runId: string;
    fromChannel?: boolean;
    groupConversation?: boolean;
    groupId?: string;
    publicRunId?: string;
    delegated?: boolean;
    references?: string[];
    extraHostTools?: import("./memories.ts").HostTools;
    /** The turn's model service and language, for a routine created during it. */
    turn: Pick<PiPromptInput, "provider" | "model" | "locale" | "botId">;
    adapter?: PiEventAdapter;
    stop?: () => Promise<void>;
    steer?: (text: string, requestId: string) => Promise<void>;
    steering?: Map<string, { text: string; done: Promise<void> }>;
    stopRequested: boolean;
    vaultAbort: AbortController;
    memoryDelivered?: () => void;
    limit?: string;
    deadline?: ReturnType<typeof createRunDeadline>;
    /** Browsers watching the run; it keeps going with none (a closed tab does not stop it). */
    watchers: Set<(event: AgentUXEvent) => void>;
    done: Promise<void>;
  };
  const runs = new Map<string, RunSlot>();
  /** When a turn was last accepted or ended. The keeper's per-minute sampling cannot see a short
   *  turn, so it reads this (as an age) instead of inferring activity from `activeRuns`. */
  let lastRunTouchedAt: number | undefined;
  const disposed = new AbortController();
  /** Session resets and configurations in flight, one at a time per conversation. A turn waits
   *  for both; a reset that fails also fails the turns queued behind it. */
  const resets = new Map<string, Promise<void>>();
  const configuring = new Map<string, Promise<void>>();
  const sessionOp = (id: string) => resets.get(id) ?? configuring.get(id);
  /** Keeps `op` as the conversation's current one until it settles. */
  const track = (ops: Map<string, Promise<void>>, id: string, op: Promise<void>) => {
    ops.set(id, op);
    const clear = () => { if (ops.get(id) === op) ops.delete(id); };
    void op.then(clear, clear);
    return op;
  };
  /** remember / forget and the browser for one conversation's agent; downloads land in its own workspace. */
  const hostToolsFor = (conversationId: string, agent: AgentPresetId) => {
    const toolkit = mergeHostTools(
    artifactTools(layout, agent, privatePaths, async (file, capture, signal) => {
      const slot = runs.get(conversationId);
      if (!slot?.adapter || slot.stopRequested || signal?.aborted) throw new Error("The artifact run is no longer active.");
      if (!capture) {
        slot.adapter.apply({ type: "artifact_published", ...file });
        return;
      }
      // Group events are projected with the member identity before the parent conversation is
      // persisted. Store that exact public identity so HTTP history cannot guess by filename.
      const publicConversationId = slot.groupId ?? conversationId;
      const publicRunId = slot.publicRunId ?? slot.runId;
      const eventArtifactId = slot.groupId ? `${slot.turn.botId ?? agent}~${file.artifactId}` : file.artifactId;
      const publicArtifactId = JSON.stringify([publicRunId, "artifactId", eventArtifactId]);
      let saved: Awaited<ReturnType<ArtifactVersionStore["save"]>> | undefined;
      try {
        saved = await artifactVersions.save({ conversationId: publicConversationId, sourceConversationId: conversationId,
          artifactId: publicArtifactId, sourceArtifactId: file.artifactId, eventArtifactId, scope: capture.scope, path: capture.path,
          agent, name: capture.name, title: file.title, mimeType: file.mimeType, bytes: capture.bytes, versionId: capture.versionId, runId: publicRunId, sourceRunId: slot.runId });
        if (slot.stopRequested || signal?.aborted || runs.get(conversationId) !== slot) throw new Error("The artifact run is no longer active.");
        slot.adapter.apply({ type: "artifact_published", ...file });
      } catch (error) {
        await saved?.rollback().catch(() => {});
        throw error;
      }
    }),
    options.vault && options.browser ? vaultToolsFor({ store: options.vault, browser: options.browser, conversationId,
      currentRun: () => {
        const slot = runs.get(conversationId);
        return slot?.adapter && !slot.stopRequested ? { runId: slot.runId, botId: slot.turn.botId ?? agent,
          locale: slot.turn.locale, fromChannel: slot.fromChannel, groupConversation: slot.groupConversation, signal: slot.vaultAbort.signal } : undefined;
      },
      requests: vaultRequests,
      announce: (toolCallId, view) => {
        const slot = runs.get(conversationId);
        if (!slot?.adapter || slot.stopRequested || slot.runId !== view.runId) throw new Error("Vault request expired.");
        slot.adapter.apply({ type: "vault_input_required", toolCallId, request: view });
        store.flush(conversationId);
      },
      resolved: (toolCallId, requestId, result) => {
        const slot = runs.get(conversationId);
        slot?.adapter?.apply({ type: "vault_input_resolved", toolCallId, requestId,
          message: vaultResultMessage(slot.turn.locale ?? "en", result) });
        store.flush(conversationId);
      }, log,
    }) : undefined,
    options.memory?.toolsFor({ conversationId, agent, botId: runs.get(conversationId)?.turn.botId ?? store.get(conversationId)?.botId ?? agent,
      groupId: runs.get(conversationId)?.groupId }),
    options.skills?.toolsFor(() => botConfig?.require(runs.get(conversationId)?.turn.botId ?? store.get(conversationId)?.botId ?? agent).skillIds ?? []),
    createConversationHistoryTools({ store, conversationId: runs.get(conversationId)?.groupId ?? conversationId,
      allowedConversationIds: runs.get(conversationId)?.references }),
    runs.get(conversationId)?.extraHostTools,
    options.browser?.toolsFor({ conversationId, agent,
      saveDownload: (name, bytes) => saveWorkspaceDownload(layout, agent, name, bytes, privatePaths),
      ask: (questions, signal) => askUser(conversationId, { toolCallId: `browser_takeover_${randomUUID()}`, questions, signal: signal ?? new AbortController().signal }) }),
    );
    if (!toolkit || !runs.get(conversationId)?.delegated) return toolkit;
    const names = new Set(["search_chat_history", "read_chat_history", "recall_memories", "read_skill"]);
    return { specs: toolkit.specs.filter(tool => names.has(tool.name)), run: (name: string, args: unknown, signal?: AbortSignal) => names.has(name) ? toolkit.run(name, args, signal) : Promise.resolve({ text: "Tool unavailable in a delegated read-only task.", isError: true }) };
  };
  const askUser = async (conversationId: string, { toolCallId, questions, signal }: UserInputRequest) => {
    if (runs.get(conversationId)?.delegated) throw new Error("Background delegated tasks cannot request user input.");
    const adapter = runs.get(conversationId)?.adapter;
    if (!adapter) throw new Error("The question's run is no longer active.");
    let pending: PendingUserInput | undefined;
    let answers: UserAnswers | undefined;
    try {
      return await userInputGate.wait(conversationId, toolCallId, questions, signal, (request) => {
        pending = request;
        adapter.apply({ type: "user_input_required", ...request });
      }, (value) => {
        answers = value;
        adapter.apply({ type: "user_input_resolved", requestId: pending!.requestId, toolCallId, questions, answers });
      });
    } finally {
      if (pending && answers === undefined) adapter.apply({ type: "user_input_resolved", requestId: pending.requestId, toolCallId });
    }
  };
  const setupChannel = (conversationId: string, { toolCallId, platform, signal }: ChannelSetupRequest) => {
    const slot = runs.get(conversationId), adapter = slot?.adapter;
    if (!adapter || slot.delegated || !options.channelSetup) throw new Error("Channel setup is not available in this run.");
    return options.channelSetup({ conversationId, platform, signal, botId: slot.turn.botId, fromChannel: slot?.fromChannel === true,
      announce: (requestId, state) => adapter.apply({ type: "channel_setup", requestId, toolCallId, state }),
      resolved: (requestId) => adapter.apply({ type: "channel_setup_resolved", requestId, toolCallId }),
    });
  };
  const createRoutine = async (conversationId: string, request: RoutineRequest) => {
    const slot = runs.get(conversationId);
    if (!slot || slot.delegated || !options.createRoutine) throw new Error("Routines are not available in this run.");
    const definition = slot.turn.provider ? providerDefinitions.get(slot.turn.provider) : undefined;
    return options.createRoutine({ ...request, fromConversationId: conversationId, botId: slot.turn.botId, locale: slot.turn.locale,
      ...(definition ? { model: { definition, model: slot.turn.model ?? definition.models[0] } } : {}) });
  };
  /** A run registers how to stop it once it has started; a stop that arrived earlier applies now. */
  const registerStop = async (conversationId: string, adapter: PiEventAdapter, stop: () => Promise<void>) => {
    const slot = runs.get(conversationId);
    if (!slot) return;
    slot.adapter = adapter;
    slot.stop = stop;
    if (slot.limit) adapter.apply({ type: "extension_error", message: slot.limit });
    if (slot.stopRequested) await stop();
  };
  let activeConversationId = defaultConversationId;
  /** Provider definitions and session keys from settings, for CLI harnesses that need them. */
  const providerStore = options.providers ?? new ProviderStore();
  const providerDefinitions = new Map<string, PiProviderDefinition>();
  try { for (const p of providerStore.view().providers?.connections ?? []) if (p.enabled) providerDefinitions.set(p.id, piRuntimeConfigurationForProvider(p).providerDefinition!); } catch { /* Exposed by the settings endpoint; do not overwrite damaged storage. */ }
  // Saved settings are authoritative even when an older IM/routine/browser carries a definition.
  // Before the first save, runtime configuration remains the source of provider definitions.
  const requireEnabledProvider = (providerId?: string) => {
    if (!providerId) return;
    const saved = providerStore.view().providers?.connections.find(p => p.id === providerId);
    if (saved && !saved.enabled) throw new Error(`${saved.label} model service is disabled. Enable it in settings or choose another model service.`);
  };
  const providerKeys = new Map<string, string>();
  const hostCredentialConversations = new Set<string>();
  const resolveProviderKey = (definition: PiProviderDefinition, conversationId?: string) => definition.authMode === "none" ? undefined
    : (conversationId && hostCredentialConversations.has(conversationId) ? undefined : providerKeys.get(providerBinding(definition))) ?? providerStore.resolve(definition) ?? providerStore.environmentKey(definition);
  /** Product conversation → the CLI's own session id, so follow-up turns resume it. */
  const cliSessions = new Map<string, { harness: AgentHarnessId; id: string }>();
  /**
   * Earlier prompts of this conversation that no engine received: every saved turn lacks a native
   * checkpoint and the engine has no session to resume, so the next turn starts fresh without them.
   * Legacy records (no turns, or Pi's absent session id) and branches resume as before.
   */
  const unseenPrompts = (conversationId: string, harness: AgentHarnessId): string[] => {
    const saved = store.get(conversationId);
    const turns = saved?.turns ?? [];
    if (!saved || !turns.length || saved.branch || turns.some((turn) => turn.native)) return [];
    const bound = harness === "pi" ? saved.piSessionId !== null
      : (cliSessions.get(conversationId) ?? saved.cliSession)?.harness === harness;
    return bound ? [] : turns.map((turn) => turn.prompt).filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim().length > 0);
  };

  const bridge = (conversationId = activeConversationId) => {
    const id = normalizeConversationId(conversationId);
    activeConversationId = id;
    const slot = runs.get(id);
    const toolContext = JSON.stringify([slot?.groupId, slot?.delegated, slot?.references, slot?.extraHostTools ? slot.runId : undefined]);
    const existing = bridgePromises.get(id);
    if (existing && bridgeToolContexts.get(id) === toolContext) {
      bridgePromises.delete(id);
      bridgePromises.set(id, existing);
      return existing;
    }
    bridgeToolContexts.set(id, toolContext);
    const created = (existing ? existing.then(current => current.dispose()) : Promise.resolve()).then(() => bridgeFactory({ delegated: slot?.delegated, hostTools: hostToolsFor(id, "assistant"), cwd, approvalGate: gateFor(id), sessionDir: join(dataDir, "pi-sessions", encodeURIComponent(id)), onUserInput: (request) => askUser(id, request),
      ...(options.channelSetup && !slot?.delegated ? { onChannelSetup: (request: ChannelSetupRequest) => setupChannel(id, request) } : {}),
      ...(options.createRoutine && !slot?.delegated ? { onCreateRoutine: (request: RoutineRequest) => createRoutine(id, request) } : {}) })).catch((error) => {
      bridgePromises.delete(id);
      throw error;
    });
    bridgePromises.set(id, created);
    // Evict the least recently used idle conversations; a running one keeps its session.
    for (const oldestId of [...bridgePromises.keys()]) {
      if (bridgePromises.size <= maxConversations) break;
      if (runs.has(oldestId)) continue;
      const oldest = bridgePromises.get(oldestId);
      bridgePromises.delete(oldestId);
      void oldest?.then((current) => current.dispose());
    }
    return created;
  };

  /** Read-only facts for the settings page. Env var *names* only, never values. */
  const runtimeInfo = () => ({
    sandboxed,
    secretPaths,
    protectedPaths,
    readOnlyPaths,
    alwaysAllowed: approvalMemory.list(),
    workspace: layout,
    envKeys: Object.keys(process.env).filter((key) => /(_API_KEY|_AUTH_TOKEN)$/.test(key) && Boolean(process.env[key])).sort(),
    sessionKeyProviders: [...providerDefinitions.values()].filter(d => providerKeys.has(providerBinding(d))).map(d => d.id),
  });

  const state = async (conversationId = activeConversationId): Promise<PiRuntimeState> => {
    const cliHarnesses = await detectCliHarnesses().catch(() => []);
    try {
      const current = await bridge(conversationId);
      return {
        available: true,
        cwd,
        running: runs.has(normalizeConversationId(conversationId)),
        ...(await current.state()),
        harnesses: [{ id: "pi", available: true }, ...cliHarnesses],
        defaultPermissionMode,
        ...runtimeInfo(),
      };
    } catch (error) {
      return {
        available: false,
        cwd,
        running: false,
        models: [],
        tools: [],
        harnesses: [{ id: "pi", available: false, error: errorMessage(error) }, ...cliHarnesses],
        defaultPermissionMode,
        ...runtimeInfo(),
        error: errorMessage(error),
      };
    }
  };

  /** A provider definition plus the key to reach it: the session key, else the host's env var. */
  const providerCredentials = (providerId?: string, conversationId?: string) => {
    requireEnabledProvider(providerId);
    const definition = providerId ? providerDefinitions.get(providerId) : undefined;
    if (!definition) return undefined;
    const apiKey = resolveProviderKey(definition, conversationId);
    return { definition, apiKey };
  };

  /** Model titles wait for the run to end: a write during a run would also persist its buffered events. */
  const pendingTitles = new Map<string, { createdAt: number; title: string }>();
  const applyTitle = (id: string, createdAt: number, title: string) => {
    if (runs.has(id)) { pendingTitles.set(id, { createdAt, title }); return; }
    try {
      if (store.setSummaryTitle(id, createdAt, title)) log("conversation.titled", { conversationId: id });
    } catch { log("conversation.title_failed", { conversationId: id, status: "storage" }); }
  };
  /** Summarizes a new conversation's first prompt with the turn's own model service. */
  const titleConversation = async (id: string, createdAt: number, input: PiPromptInput, prompt: string) => {
    try {
      const credentials = providerCredentials(input.provider, id);
      if (!credentials || (credentials.definition.authMode !== "none" && !credentials.apiKey)) return;
      const title = await summarizeConversationTitle(credentials.definition, credentials.apiKey,
        input.model ?? credentials.definition.models[0], prompt);
      if (title) applyTitle(id, createdAt, title);
      else log("conversation.title_failed", { conversationId: id, status: "empty" });
    } catch { log("conversation.title_failed", { conversationId: id, status: "request" }); }
  };

  const codexProvider = (providerId?: string, model?: string, conversationId?: string) => {
    const credentials = providerCredentials(providerId, conversationId);
    if (!credentials) {
      throw new Error("Codex has no model service configured. Save the model service in settings, or switch Codex to its local login.");
    }
    const { definition, apiKey } = credentials;
    if (definition.protocol !== "openai-compatible") {
      throw new Error(`${definition.name} is not OpenAI-compatible; Codex needs a Responses API endpoint.`);
    }
    if (!apiKey) {
      throw new Error(`${definition.name} API key is not set. Enter it in settings, or set ${definition.apiKeyEnvVar ?? "its key"} on the server.`);
    }
    return { name: definition.name, baseUrl: definition.baseUrl, apiKey, model: model ?? definition.models[0] };
  };

  const claudeProvider = (providerId?: string, model?: string, engine = "Claude Code", conversationId?: string) => {
    requireEnabledProvider(providerId);
    const definition = providerId ? providerDefinitions.get(providerId) : undefined;
    if (!definition) {
      throw new Error(`${engine} has no model service configured. Save the model service in settings.`);
    }
    const baseUrl = anthropicBaseUrlForProvider(definition);
    if (!baseUrl) throw new Error(`${definition.name} has no Anthropic-compatible endpoint, which ${engine} needs.`);
    const apiKey = resolveProviderKey(definition, conversationId);
    if (!apiKey) {
      throw new Error(`${definition.name} API key is not set. Enter it in settings, or set ${definition.apiKeyEnvVar ?? "its key"} on the server.`);
    }
    return { baseUrl, apiKey, model: model ?? definition.models[0] };
  };

  const runPiPrompt = async (
    input: PiPromptInput,
    conversationId: string,
    prompt: string,
    onEvent: (event: AgentUXEvent) => void,
    modelPrompt: string,
  ) => {
    const current = await bridge(conversationId);
    requireEnabledProvider(input.provider ?? (await current.state()).provider);
    current.setRolePrompt?.(rolePrompt(isAgentPresetId(input.agentPreset) ? input.agentPreset : "assistant", layout, { sandboxed, locale: input.locale, botId: input.botId, availableBots: input.availableBots, profile: botConfig?.require(input.botId ?? input.agentPreset ?? "assistant") }));
    const approvalGate = gateFor(conversationId);
    approvalGate.setCwd(cwd);
    approvalGate.setMode(input.permissionMode ?? "request");
    approvalGate.setAgent(isAgentPresetId(input.agentPreset) ? input.agentPreset : "assistant");
    if (input.provider || input.model || input.thinkingLevel) {
      const definition = input.provider ? providerDefinitions.get(input.provider) : undefined;
      const apiKey = definition ? resolveProviderKey(definition, conversationId) : undefined;
      await current.configure({ provider: input.provider, model: input.model, thinkingLevel: input.thinkingLevel,
        ...(definition ? { providerDefinition: { ...definition, apiKeyEnvVar: undefined }, apiKey, clearApiKey: !apiKey } : {}) });
    }

    const adapter = createPiEventAdapter({
      runId: input.requestId ?? `pi_${randomUUID()}`,
      resolveFilePath: path => artifactPath(layout.agents[isAgentPresetId(input.agentPreset) ? input.agentPreset : "assistant"], path),
      onEvent,
      requiresApproval: (toolName, args) => toolName !== "ask_user" && approvalGate.requiresApproval(toolName, args),
    });
    const unsubscribe = current.subscribe((event) => {
      if (event.type === "message_start" && asRecord(event.message).role === "assistant") runs.get(conversationId)?.memoryDelivered?.();
      // The SDK reports a cancelled approval/tool as an error before abort() settles.
      // Leave it open for the final cancellation, rather than persisting a false failure.
      if (runs.get(conversationId)?.stopRequested && event.type === "tool_execution_end" && event.isError === true) return;
      // Pi can report an aborted request as an error before abort() resolves.
      // Once the SDK settles a requested stop, its terminal belongs to cancellation.
      if (runs.get(conversationId)?.stopRequested && (event.type === "agent_settled" || event.type === "extension_error")) {
        adapter.finish("cancelled");
      } else adapter.apply(event);
    });
    await registerStop(conversationId, adapter, async () => {
      approvalGate.cancelAll("Pi run was stopped.");
      await current.abort();
      adapter.finish("cancelled");
    });
    try {
      // Once per conversation, before the first prompt. Canonical events accumulate across
      // turns in the browser, so announcing on every turn would stack a duplicate row in
      // `CapabilityTray` per turn.
      if (!announcedCapabilities.has(conversationId)) {
        announcedCapabilities.add(conversationId);
        const tools = await current.state().then((value) => value.tools).catch(() => []);
        adapter.attachCapabilities(tools);
      }
      // A stop that landed before the prompt started has nothing to abort yet; honour it here,
      // with no await between this check and the prompt.
      if (runs.get(conversationId)?.stopRequested) return;
      adapter.startUserMessage(prompt);
      const slot = runs.get(conversationId)!;
      if (current.steer && !slot.groupConversation) slot.steer = async (text, requestId) => {
        await current.steer!(withReplyLanguage(text, input.locale));
        adapter.startUserMessage(text, requestId);
      };
      await current.prompt(modelPrompt);
      if (!slot.stopRequested) slot.memoryDelivered?.();
      adapter.finish(runs.get(conversationId)?.stopRequested ? "cancelled" : "success");
    } catch (error) {
      if (runs.get(conversationId)?.stopRequested) adapter.finish("cancelled");
      else adapter.apply({ type: "extension_error", message: errorMessage(error) });
    } finally {
      unsubscribe();
      approvalGate.cancelAll();
    }
  };

  const runCliPrompt = async (
    role: AgentPresetId,
    harness: Exclude<AgentHarnessId, "pi">,
    input: PiPromptInput,
    conversationId: string,
    prompt: string,
    onEvent: (event: AgentUXEvent) => void,
    modelPrompt: string,
  ) => {
    const permissionMode = input.permissionMode ?? "request";
    const runCwd = layout.agents[role];
    const sharedDirs = layout.shared ? [layout.shared] : [];
    const plannerMayWrite = (args: Record<string, unknown>) => {
      const path = typeof args.path === "string" ? args.path : undefined;
      if (!layout.shared || !path) return false;
      const target = resolvePath(runCwd, path);
      return target === layout.shared || target.startsWith(`${layout.shared}/`);
    };
    const approvalGate = gateFor(conversationId);
    approvalGate.setMode(permissionMode);
    approvalGate.setCwd(runCwd);
    approvalGate.setAgent(role);
    // Set only while a call is announced on hold, so the adapter marks exactly that call.
    let announcingHold = false;
    const adapter = createPiEventAdapter({
      runId: input.requestId ?? `${harness}_${randomUUID()}`,
      resolveFilePath: path => artifactPath(runCwd, path),
      onEvent,
      requiresApproval: () => announcingHold,
    });
    const run = new AbortController();
    await registerStop(conversationId, adapter, async () => {
      approvalGate.cancelAll("Pi run was stopped.");
      run.abort();
      adapter.finish("cancelled");
    });
    const binding = cliSessions.get(conversationId) ?? store.get(conversationId)?.cliSession;
    const branch = !binding ? store.get(conversationId)?.branch?.native : undefined;
    const resumeId = binding?.harness === harness ? binding.id : branch?.harness === harness ? branch.sessionId : undefined;
    const onSessionId = (id: string) => {
      if (cliSessions.get(conversationId)?.id === id) return;
      store.setCliSession(conversationId, { harness, id });
      cliSessions.set(conversationId, { harness, id });
    };
    const emit = (event: PiWireEvent) => adapter.apply(event);
    // Claude reports a checkpoint for every assistant message; only the last one is a branch point,
    // so keep it in memory and write the conversation once when the run ends.
    let nativeTurn: NativeTurnCheckpoint | undefined;
    const onNativeTurn = ({ sessionId, id }: { sessionId: string; id: string }) => {
      if (harness === "dsh") return; // ACP has native resume but no trustworthy fork checkpoint.
      nativeTurn = harness === "claude-code" ? { harness, sessionId, afterMessageId: id } : { harness, sessionId, turnId: id };
      runs.get(conversationId)?.memoryDelivered?.();
    };
    const onUserInput = (request: UserInputRequest) => askUser(conversationId, request);
    let lease: { revoke(): void } | undefined;
    /** Put a call on hold and wait for the user. Throws when it is denied or the run stops. */
    const hold = async (toolCallId: string, toolName: string, args: unknown, announce: () => boolean) => {
      announcingHold = true;
      const fresh = announce();
      announcingHold = false;
      if (!fresh) adapter.requestApproval(toolCallId, args);
      await approvalGate.wait(toolCallId, toolName, args, run.signal);
    };
    try {
      adapter.startUserMessage(prompt);
      if (sandboxed) requireAgentIsolation();
      if (harness === "dsh") {
        if (sandboxed) throw new Error("DSH is currently available for local testing only.");
        const provider = await modelLease(claudeProvider(input.provider, input.model, "DeepSeek Harness", conversationId), "anthropic", conversationId, input.thinkingLevel);
        lease = provider;
        await runDsh({
          cwd: runCwd, home: join(dataDir, "dsh", encodeURIComponent(conversationId)), prompt: modelPrompt,
          systemPrompt: rolePrompt(role, layout, { sandboxed, locale: input.locale, botId: input.botId, availableBots: input.availableBots, profile: botConfig?.require(input.botId ?? input.agentPreset ?? "assistant") }),
          permissionMode, resumeId, signal: run.signal, emit, onSessionId, onUserInput,
          onAccepted: () => runs.get(conversationId)?.memoryDelivered?.(),
          provider, webTools, mcpTools: runs.get(conversationId)?.delegated ? undefined : options.mcpTools?.(input.botId ?? role), hostTools: hostToolsFor(conversationId, role),
          async onPermission(request) {
            const refusal = approvalGate.refusalReason(request.tool.name, request.tool.args);
            if (refusal) return refusal;
            if (!approvalGate.requiresApproval(request.tool.name, request.tool.args)) { request.startExecution(); return true; }
            try { await hold(request.toolCallId, request.tool.name, request.tool.args, request.startExecution); return true; }
            catch (error) { return errorMessage(error); }
          },
        });
      } else if (harness === "claude-code") {
        if (sandboxed && input.claudeCodeModelSource === "local-login") throw new Error("Sandbox agents require a configured model service; local login is disabled.");
        const provider = input.claudeCodeModelSource === "local-login" ? undefined
          : await modelLease(claudeProvider(input.provider, input.model, "Claude Code", conversationId), "anthropic", conversationId, input.thinkingLevel);
        lease = provider;
        await runClaudeCode({
          cwd: runCwd,
          addDirs: sharedDirs,
          prompt: modelPrompt,
          permissionMode,
          resumeId,
          forkAtMessageId: branch?.harness === "claude-code" ? branch.messageId : undefined,
          onNativeTurn,
          initialTaskPlan: resumeId ? lastClaudeTaskPlan(store.get(conversationId)?.events ?? []) : undefined,
          onUserInput,
          signal: run.signal,
          emit,
          onSessionId,
          provider,
          appendSystemPrompt: rolePrompt(role, layout, { sandboxed, locale: input.locale, botId: input.botId, availableBots: input.availableBots, profile: botConfig?.require(input.botId ?? input.agentPreset ?? "assistant") }),
          disallowedTools: agentPreset(role).disallowedTools,
          webTools,
          mcpTools: runs.get(conversationId)?.delegated ? undefined : options.mcpTools?.(input.botId ?? role),
          hostTools: hostToolsFor(conversationId, role),
          async onPermission(request) {
            // The planner writes only into the shared directory: plans and handoffs for others.
            if (request.tool.name === "write" && !plannerMayWrite(request.tool.args)) {
              return layout.shared
                ? `The planner may only write inside ${layout.shared}.`
                : "The planner does not write files.";
            }
            const refusal = approvalGate.refusalReason(request.tool.name, request.tool.args);
            if (refusal) return refusal;
            if (!approvalGate.requiresApproval(request.tool.name, request.tool.args)) {
              request.startExecution();
              return true;
            }
            try {
              await hold(request.toolCallId, request.tool.name, request.tool.args, request.startExecution);
              return true;
            } catch (error) {
              return errorMessage(error);
            }
          },
        });
      } else {
        if (sandboxed && input.codexModelSource === "local-login") throw new Error("Sandbox agents require a configured model service; local login is disabled.");
        const configured = input.codexModelSource === "local-login" ? undefined : codexProvider(input.provider, input.model, conversationId);
        const provider = configured ? { ...configured, ...await modelLease(configured, "openai", conversationId, input.thinkingLevel) } : undefined;
        lease = provider;
        await runCodex({
          onUserInput,
          cwd: runCwd,
          addDirs: sharedDirs,
          prompt: modelPrompt,
          developerInstructions: rolePrompt(role, layout, { sandboxed, locale: input.locale, botId: input.botId, availableBots: input.availableBots, profile: botConfig?.require(input.botId ?? input.agentPreset ?? "assistant") }),
          permissionMode,
          resumeId,
          forkBeforeTurnId: branch?.harness === "codex" ? branch.beforeTurnId : undefined,
          onNativeTurn,
          signal: run.signal,
          emit,
          onSessionId,
          provider,
          webTools,
          mcpTools: runs.get(conversationId)?.delegated ? undefined : options.mcpTools?.(input.botId ?? role),
          hostTools: hostToolsFor(conversationId, role),
          async onPermission(request) {
            const refusal = approvalGate.refusalReason(request.tool.name, request.tool.args);
            if (refusal) return refusal;
            if (!approvalGate.requiresApproval(request.tool.name, request.tool.args)) {
              request.startExecution();
              return true;
            }
            try {
              await hold(request.toolCallId, request.tool.name, request.tool.args, request.startExecution);
              return true;
            } catch (error) { return errorMessage(error); }
          },
        });
      }
      adapter.finish(run.signal.aborted ? "cancelled" : "success");
    } catch (error) {
      if (run.signal.aborted) adapter.finish("cancelled");
      else adapter.apply({ type: "extension_error", message: errorMessage(error) });
    } finally {
      if (nativeTurn) {
        try { store.saveNativeTurn(conversationId, input.requestId!, nativeTurn); }
        catch { log("run.checkpoint_failed", { conversationId, harness }); }
      }
      run.abort();
      lease?.revoke();
      approvalGate.cancelAll();
    }
  };

  /** Stops one conversation's run, or every run. A stop before the run has started is kept. */
  const abortRuns = async (conversationId?: string, runId?: string) => {
    const targets = conversationId === undefined
      ? [...runs.values()]
      : [runs.get(normalizeConversationId(conversationId))].filter((slot): slot is RunSlot => Boolean(slot));
    if (runId !== undefined && (conversationId === undefined || targets[0]?.runId !== runId)) return false;
    await Promise.all(targets.map(async (slot) => {
      slot.stopRequested = true;
      slot.vaultAbort.abort();
      await slot.stop?.();
    }));
    return true;
  };

  const api: PiRuntimeController = {
    artifactVersions,
    learning,
    usage: () => usage.list(),
    state,
    defaultPermissionMode,
    health: () => ({ status: "ok", activeRuns: runs.size, maxConcurrentRuns, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // An age, not a timestamp: the keeper's clock and the sandbox's need not agree.
      lastRunAgoMs: lastRunTouchedAt === undefined ? undefined : Math.max(0, Date.now() - lastRunTouchedAt) }),
    async configure(input) {
      const conversationId = normalizeConversationId(input.conversationId);
      const idle = () => { if (runs.has(conversationId)) throw new ConversationRequestError("Stop this conversation's run before changing its configuration.", 409); };
      idle();
      // Checked again after waiting, with nothing awaited before this configuration registers.
      for (let op = sessionOp(conversationId); op; op = sessionOp(conversationId)) await op.catch(() => undefined);
      idle();
      await track(configuring, conversationId, (async () => {
        requireEnabledProvider(input.provider);
        if (input.providerDefinition) requireEnabledProvider(input.providerDefinition.id);
        if (input.providerDefinition) providerDefinitions.set(input.providerDefinition.id, input.providerDefinition);
        if (input.credentialSource === "host") hostCredentialConversations.add(conversationId);
        else if (input.apiKey) hostCredentialConversations.delete(conversationId);
        const definition = input.provider ? providerDefinitions.get(input.provider) : undefined;
        if (definition) {
          const binding = providerBinding(definition);
          if (input.apiKey) providerKeys.set(binding, input.apiKey);
          else if (input.clearApiKey) providerKeys.delete(binding);
          const apiKey = resolveProviderKey(definition, conversationId);
          input = { ...input, providerDefinition: { ...definition, apiKeyEnvVar: undefined }, apiKey, clearApiKey: !apiKey };
        }
        const current = await bridge(conversationId);
        await current.configure(input);
      })());
      return state(conversationId);
    },
    async runPrompt(input, onEvent, options) {
      if (input.artifactSubmission !== undefined && (!validArtifactSubmission(input.artifactSubmission) || input.artifactSubmission.submissionId !== input.requestId)) throw new Error("Invalid artifact submission identity.");
      const prompt = input.prompt?.trim() ? redactCredentials(input.prompt.trim()) : undefined;
      if (!prompt) throw new Error("Pi prompt is empty.");
      const conversationId = normalizeConversationId(input.conversationId);
      const references = conversationReferences(store, input.referencedConversationIds, store.get(options?.groupId ?? conversationId));
      input = { ...input, requestId: input.requestId ?? `run_${randomUUID()}` };
      for (;;) {
        disposed.signal.throwIfAborted();
        if (runs.has(conversationId)) throw new Error("This conversation already has a run in progress.");
        if (options?.waitForCapacity) options.signal?.throwIfAborted();
        if (!options?.waitForCapacity && runs.size >= maxConcurrentRuns) {
          throw new Error(`${maxConcurrentRuns} conversations are already running. Wait for one to finish or stop it.`);
        }
        if (store.get(conversationId)?.turns?.some(turn => turn.runId === input.requestId)) throw new Error("This request id has already been submitted.");
        if (runs.size < maxConcurrentRuns) break;
        // Completion only wakes us: another waiter may take the free slot first. Waiting does
        // not own a conversation or attach its signal to any already-running turn.
        let stopWaiting = () => {};
        try {
          await Promise.race([
            ...[...runs.values()].map(slot => slot.done),
            new Promise<never>((_, reject) => {
              const cancel = () => reject(options?.signal?.reason);
              const shutDown = () => reject(disposed.signal.reason);
              options?.signal?.addEventListener("abort", cancel, { once: true });
              disposed.signal.addEventListener("abort", shutDown, { once: true });
              stopWaiting = () => {
                options?.signal?.removeEventListener("abort", cancel);
                disposed.signal.removeEventListener("abort", shutDown);
              };
            }),
          ]);
        } finally { stopWaiting(); }
      }
      // No await after the final checks: another prompt cannot take this conversation or slot.
      let settle!: () => void;
      const slot: RunSlot = { runId: input.requestId!, fromChannel: options?.fromChannel, groupConversation: options?.groupConversation, groupId: options?.groupId, publicRunId: options?.publicRunId, delegated: options?.delegated, extraHostTools: options?.extraHostTools,
        references, turn: { provider: input.provider, model: input.model, locale: input.locale }, vaultAbort: new AbortController(), stopRequested: false, watchers: new Set(), done: new Promise<void>((resolve) => { settle = resolve; }) };
      runs.set(conversationId, slot);
      learning.interrupt();
      lastRunTouchedAt = Date.now();
      const stopOnSignal = () => void abortRuns(conversationId, slot.runId).catch(() => undefined);
      if (options?.signal?.aborted) stopOnSignal();
      options?.signal?.addEventListener("abort", stopOnSignal, { once: true });
      gateFor(conversationId).setReadOnly(options?.readOnly ?? false);
      const role = isAgentPresetId(input.agentPreset) ? input.agentPreset : "assistant";
      const harness = agentPreset(role).harness;
      const runStartedAt = Date.now();
      let outputBytes = 0;
      let terminalStatus = "error";
      const exceed = (kind: "duration" | "output", message: string) => {
        if (slot.limit) return;
        slot.limit = message;
        log("run.limit", { conversationId, harness, limit: kind });
        // Defer to avoid calling the adapter recursively from its own event callback.
        queueMicrotask(() => {
          slot.adapter?.apply({ type: "extension_error", message });
          void abortRuns(conversationId, slot.runId).catch(() => undefined);
        });
      };
      const deadline = createRunDeadline(limits.durationMs, () => exceed("duration", "This turn reached its time limit (RAYTONEBOT_RUN_TIMEOUT_MS). Work so far is kept; send \"continue\" to resume."));
      slot.deadline = deadline;
      log("run.started", { conversationId, harness });
      let opened = false;
      const recorder = createConversationRecorder({ store, conversationId, runId: input.requestId,
        broadcast(event) {
          onEvent(event);
          for (const watcher of slot.watchers) watcher(event);
        },
        stop: () => { void abortRuns(conversationId, slot.runId).catch(() => undefined); },
      });
      const record = (event: AgentUXEvent) => {
        if (recorder.ended) return;
        const terminal = event.type === "run.finished" || event.type === "run.error";
        if (!terminal) {
          // A streaming delta costs its text, not its envelope; otherwise token-sized events
          // exhaust the budget long before the transcript holds that much content.
          const bytes = event.type.endsWith(".delta")
            ? Object.values((event.payload ?? {}) as Record<string, unknown>).reduce<number>((total, value) => total + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0)
            : Buffer.byteLength(JSON.stringify(event));
          // Preserve small block closures after stopping, never another chunk of model/tool output.
          if (slot.limit && (!/^(text|reasoning|step)\.finished$|^tool\.call\.error$/.test(event.type) || bytes > 4096)) return;
          if (!slot.limit) outputBytes += bytes;
          if (!slot.limit && outputBytes > limits.outputBytes) {
            exceed("output", "This turn reached its output limit (RAYTONEBOT_RUN_OUTPUT_BYTES). Work so far is kept; send \"continue\" to resume.");
            return;
          }
        } else {
          if (slot.limit) {
            const failure = piErrorTurnEvents({ message: slot.limit, code: "run_limit", runId: event.runId })[0];
            event = { ...failure, seq: event.seq, ts: event.ts };
          }
          terminalStatus = event.type === "run.error" ? "error" : String((event.payload as { status?: string }).status ?? "success");
        }
        recorder.record(event);
      };
      try {
        for (let op = sessionOp(conversationId); op; op = sessionOp(conversationId)) {
          // The session a failed reset leaves behind is unknown; this turn must not run in it.
          if (op === resets.get(conversationId)) await op;
          else await op.catch(() => undefined);
        }
        const saved = store.get(conversationId);
        if (botConfig) input = botConfig.input(input, saved);
        if (settingsUseProvider({ presetId: input.agentPreset ?? role,
          claudeCodeModelSource: input.claudeCodeModelSource ?? "provider", codexModelSource: input.codexModelSource ?? "provider" })) {
          requireEnabledProvider(input.provider);
        }
        const identity = resolveBotIdentity(role, input, botConfig ? { botId: saved?.botId } : saved);
        input = { ...input, botId: identity.botId, availableBots: identity.availableBots };
        slot.turn = input;
        usage.start({ runId: input.requestId!, conversationId, botId: identity.botId, harness, provider: input.provider, model: input.model, startedAt: runStartedAt });
        const fresh = !saved;
        const conversation = store.begin(conversationId, role, options?.title ?? prompt);
        opened = true;
        store.setExtra(conversationId, { botId: identity.botId, availableBots: identity.availableBots });
        if (fresh && !options?.title) void titleConversation(conversationId, conversation.createdAt, input, prompt);
        const workspacePrompt = await promptWithWorkspaceFiles(prompt, input.attachments, role, layout, privatePaths);
        const memoryNote = memory?.noteFor(conversationId, { botId: identity.botId, groupId: slot.groupId });
        const skillNote = optionsSkills?.noteFor(botConfig?.require(identity.botId).skillIds ?? []);
        slot.memoryDelivered = memoryNote?.delivered;
        const browserNote = slot.delegated ? undefined : browser?.contextNote();
        const referenceNote = conversationReferenceNote(store, references);
        const modelPrompt = withReplyLanguage(`${withUnseenPrompts(withConversationContext(workspacePrompt, options?.groupConversation), unseenPrompts(conversationId, harness))}\n\n[Current Bot identity from host configuration: ${JSON.stringify(identity.bot)}. Use this identity even if earlier messages use an old name.]${memoryNote?.text ? `\n\n${memoryNote.text}` : ""}${browserNote ? `\n\n${browserNote}` : ""}${skillNote ? `\n\n${skillNote}` : ""}`, input.locale);
        store.saveTurn(conversationId, { runId: input.requestId!, harness, prompt, ...(input.referencedConversationIds?.length ? { referencedConversationIds: input.referencedConversationIds } : {}), ...(input.artifactSubmission ? { artifactSubmission: input.artifactSubmission } : {}),
          attachments: input.attachments?.map(({ scope, path, name }) => ({ scope, path, ...(name ? { name } : {}) })) });
        const learningNote = slot.groupId || slot.delegated ? undefined : learning.noteFor(identity.botId, harness, prompt);
        const referencedPrompt = referenceNote ? `${modelPrompt}\n\n${referenceNote}` : modelPrompt;
        const fullPrompt = learningNote ? `${referencedPrompt}\n\n${learningNote}` : referencedPrompt;
        if (harness !== "pi") await runCliPrompt(role, harness, input, conversationId, prompt, record, fullPrompt);
        else await runPiPrompt(input, conversationId, prompt, record, fullPrompt);
      } catch (error) {
        if (!opened) throw error; // No acceptance or model action if existing history cannot be opened.
        // Bridge/configuration failures can precede the adapter. Persist the failed submission
        // too, so a client that lost the response can recover its prompt and error by requestId.
        if (!recorder.failed) {
          try {
            for (const event of piErrorTurnEvents({ prompt, message: errorMessage(error), runId: input.requestId })) record(event);
          } catch (failure) { if (!recorder.failed) throw failure; }
        }
      } finally {
        slot.vaultAbort.abort();
        deadline.dispose();
        options?.signal?.removeEventListener("abort", stopOnSignal);
        try {
          if (opened && !recorder.finish()) terminalStatus = "error";
        } finally {
          runs.delete(conversationId);
          if (staleBridges.delete(conversationId)) dropBridge(conversationId);
          settle();
        }
        log("run.ended", { conversationId, harness, status: terminalStatus, durationMs: Date.now() - runStartedAt, outputBytes });
        usage.end(slot.runId, terminalStatus === "success" ? "completed" : terminalStatus === "cancelled" ? "cancelled" : "failed", conversationId);
        learning.idle();
        // Learning is best effort after durable completion, outside the foreground model loop.
        if (opened && !recorder.failed && terminalStatus === "success" && !slot.groupId && !slot.delegated && !options?.title && learning.enabled) {
          try {
            const saved = store.get(conversationId);
            const evidence = saved && learningEvidence(saved.events, slot.runId);
            if (evidence && input.provider && settingsUseProvider({ presetId: role, claudeCodeModelSource: input.claudeCodeModelSource ?? "provider", codexModelSource: input.codexModelSource ?? "provider" })) {
              const configured = providerDefinitions.get(input.provider);
              const binding = configured ? JSON.stringify([configured.baseUrl, configured.protocol]) : undefined;
              learning.enqueue({ conversationId, runId: slot.runId, botId: input.botId ?? role, harness, evidence,
                async review(excerpt, signal) {
                  const credentials = providerCredentials(input.provider, conversationId);
                  if (!credentials || JSON.stringify([credentials.definition.baseUrl, credentials.definition.protocol]) !== binding || credentials.definition.authMode !== "none" && !credentials.apiKey) throw new Error("Learning provider unavailable");
                  return reviewLearning(credentials.definition, credentials.apiKey, input.model ?? credentials.definition.models[0], excerpt, signal);
                } });
            }
          } catch { /* Learning must not affect chat completion. */ }
        }
        lastRunTouchedAt = Date.now();
        const stashed = pendingTitles.get(conversationId);
        if (stashed) { pendingTitles.delete(conversationId); applyTitle(conversationId, stashed.createdAt, stashed.title); }
      }
    },
    listConversations: (query) => store.list(query).map((summary) => ({ ...summary, running: runs.has(summary.id), activeRunId: runs.get(summary.id)?.runId,
      ...(runs.has(summary.id) && awaitingUser(summary.id) ? { awaitingUser: true } : {}) })),
    awaitingUser: (conversationId) => awaitingUser(normalizeConversationId(conversationId)),
    conversationReadErrors: () => store.readErrors(),
    followRun(conversationId, after, onEvent) {
      const id = normalizeConversationId(conversationId);
      const slot = runs.get(id);
      if (!slot) return undefined;
      // Saved and live events come from the same single-threaded path, so nothing falls between.
      for (const event of (store.get(id)?.events ?? []).slice(Math.max(0, after))) onEvent(event);
      slot.watchers.add(onEvent);
      return { done: slot.done, stop: () => slot.watchers.delete(onEvent) };
    },
    registerDocument(id, document) {
      const saved = store.get(id);
      if (!saved) throw new Error("Source conversation is unavailable.");
      store.setExtra(id, { documents: [...(saved.documents ?? []).filter(d => d.scope !== document.scope || d.path !== document.path), document].slice(-100) });
    },
    getConversation(id) {
      const normalized = normalizeConversationId(id);
      const saved = store.get(normalized);
      // Read-only warning: a failed disk cannot persist its own failure terminal.
      return saved && { ...saved, activeRunId: runs.get(normalized)?.runId, incomplete: !runs.has(normalized) && piCancelledTurnEvents(saved.events).length > 0 };
    },
    refreshTools() {
      for (const id of [...bridgePromises.keys()]) {
        if (runs.has(id)) staleBridges.add(id);
        else dropBridge(id);
      }
    },
    deleteConversation(id) {
      const normalized = normalizeConversationId(id);
      if (runs.has(normalized)) {
        throw new Error("A run is already active in this conversation. Stop it before deleting the conversation.");
      }
      store.remove(normalized);
      artifactVersions.removeConversationsSync([normalized]);
    },
    renameConversation(id, title) {
      const normalized = normalizeConversationId(id);
      // A write during a run would also persist its buffered events, as with model titles.
      if (runs.has(normalized)) throw new Error("A run is already active in this conversation. Stop it before renaming the conversation.");
      pendingTitles.delete(normalized);
      return store.rename(normalized, title);
    },
    branchConversation(id, beforeRunId) {
      const sourceId = normalizeConversationId(id);
      if (!beforeRunId) throw new ConversationBranchError("beforeRunId is required.", 400);
      if (runs.has(sourceId)) throw new ConversationBranchError("Stop this conversation's run before creating a branch.");
      return store.branch(`branch_${randomUUID()}`, sourceId, beforeRunId);
    },
    refreshProviders() {
      providerKeys.clear();
      providerDefinitions.clear();
      for (const p of providerStore.view().providers?.connections ?? []) if (p.enabled) providerDefinitions.set(p.id, piRuntimeConfigurationForProvider(p).providerDefinition!);
      for (const id of bridgePromises.keys()) dropBridge(id);
    },
    async testProvider(definition, apiKey) {
      const key = apiKey?.trim() || resolveProviderKey(definition);
      return probeProvider(definition, definition.authMode === "none" ? undefined : key);
    },
    async steer(conversationId, runId, requestId, text) {
      const slot = runs.get(conversationId);
      if (!slot || slot.runId !== runId || slot.stopRequested || !slot.steer || awaitingUser(conversationId)) return false;
      const previous = slot.steering?.get(requestId);
      if (previous) {
        if (previous.text !== text) throw new Error("This input id already belongs to another message.");
        await previous.done;
        return true;
      }
      const done = slot.steer(text, requestId);
      (slot.steering ??= new Map()).set(requestId, { text, done });
      await done;
      store.flush(conversationId);
      return true;
    },
    abort: abortRuns,
    resolveVaultInput: (conversationId, requestId, runId, answer) => vaultRequests.answer(normalizeConversationId(conversationId), requestId, runId, answer),
    resolveUserInput: (conversationId, requestId, answers) => userInputGate.resolve(normalizeConversationId(conversationId), requestId, answers),
    hasApproval(toolCallId, conversationId, runId) {
      const id = normalizeConversationId(conversationId), slot = runs.get(id);
      return Boolean(slot && !slot.stopRequested && slot.runId === runId && approvalGates.get(id)?.has(toolCallId));
    },
    resolveApproval(toolCallId, decision, onlyConversationId, runId) {
      const scope = onlyConversationId === undefined ? undefined : normalizeConversationId(onlyConversationId);
      for (const [conversationId, gate] of approvalGates) {
        if (scope !== undefined && conversationId !== scope) continue;
        if (runId !== undefined && runs.get(conversationId)?.runId !== runId) continue;
        if (!gate.resolve(toolCallId, decision)) continue;
        log("approval.resolved", { conversationId, decision });
        runs.get(conversationId)?.adapter?.resolveApproval(toolCallId, decision);
        return true;
      }
      return false;
    },
    async newSession(conversationId) {
      const id = normalizeConversationId(conversationId);
      const idle = () => { if (runs.has(id)) throw new ConversationRequestError("Stop this conversation's run before starting a new session.", 409); };
      idle();
      for (let op = sessionOp(id); op; op = sessionOp(id)) await op.catch(() => undefined);
      idle();
      await track(resets, id, (async () => {
        cliSessions.delete(id);
        store.reset(id);
        const current = await bridge(id);
        await current.newSession();
        // A new session starts with an empty transcript, so its tool set has to be announced
        // again or `CapabilityTray` would stay empty for the rest of the conversation's life.
        announcedCapabilities.delete(id);
      })());
      return state(id);
    },
    clearApprovals(agentPreset) {
      approvalMemory.clear(agentPreset);
      return approvalMemory.list();
    },
    dispose() {
      learning.dispose();
      disposed.abort(new Error("Pi runtime controller is disposed."));
      for (const slot of runs.values()) slot.vaultAbort.abort();
      for (const gate of approvalGates.values()) gate.cancelAll();
      for (const pending of bridgePromises.values()) void pending.then((current) => current.dispose());
      bridgePromises.clear();
      announcedCapabilities.clear();
      void gatewayPromise?.then((current) => current.close());
    },
  };
  // Group chat wraps the controller (groupChat.ts, ADR-032).
  return attachGroupChat(api, { store, userInputGate,
    bots: options.bots,
    validateAttachments: (attachments, role) => promptWithWorkspaceFiles("", attachments, role, layout, privatePaths).then(() => {}),
    credentials: providerCredentials,
    providerDefinition: (id) => id ? providerDefinitions.get(id) : undefined,
    providerKey: (id) => providerCredentials(id)?.apiKey, log, providerIds: () => [...providerDefinitions.keys()],
    titleGroup: async (id, input, prompt) => {
      const conversation = store.get(id);
      if (conversation) await titleConversation(id, conversation.createdAt, input, prompt);
    } });
}
