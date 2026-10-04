import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";

import type { AgentUXEvent } from "@agent-ux/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  createPiEventAdapter,
  type PiApprovalDecision,
  type PiEventAdapter,
  type PiWireEvent,
} from "../harness/adapters/piAdapter.ts";
import {
  PI_API_PREFIX,
  type PiModelInfo,
  type PiPromptInput,
  type PiProviderDefinition,
  type PiRuntimeConfiguration,
  type PiRuntimeState,
} from "./piClient.ts";
import { sameOriginRequestAllowed } from "./requestOrigin.ts";
import { detectCliHarnesses, runClaudeCode, runCodex } from "./cliHarness.ts";
import { lastClaudeTaskPlan } from "./claudeTaskPlan.ts";
import { scrubSecretEnv } from "./runtime/childEnv.ts";
import { defaultProtectedPaths, defaultReadOnlyPaths, defaultSecretPaths } from "./permissionPolicy.ts";
import { resolveWorkspaceLayout, type WorkspaceLayout } from "./workspaceLayout.ts";
import { rolePrompt } from "./rolePrompt.ts";
import { listWorkspaceFiles, openWorkspaceFile, promptWithWorkspaceFiles, uploadWorkspaceFile, WorkspaceFileError } from "./workspaceFiles.ts";
import { sendWorkspaceFile } from "./workspaceDownload.ts";
import { createConversationRecorder } from "./conversationRecorder.ts";
import { assertPiSessionFile, openPiSession } from "./nativeSession.ts";
import { conversationSearchPage, SearchPageError } from "./conversationSearchPage.ts";
import { ConversationBranchError, type NativeTurnCheckpoint } from "./conversationBranch.ts";
import {
  createConversationStore,
  defaultDataDir,
  type ConversationStore,
  type ConversationSummary,
  type StoredConversation,
} from "./conversationStore.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { probeProvider, type ProviderProbeResult } from "./providerProbe.ts";
import { createHostResources } from "./piResources.ts";
import { piCancelledTurnEvents } from "./piCancelledTurn.ts";
import { piErrorTurnEvents, PROMPT_REJECTED } from "./piErrorTurn.ts";
import { PiApprovalGate, SECRET_REFUSAL, type PiPermissionMode } from "./approvalGate.ts";
import { ApprovalMemory } from "./approvalMemory.ts";
import { UserInputGate } from "./userInputGate.ts";
import type { PendingUserInput } from "../runtime/userInput.ts";
import type { UserInputRequest } from "./userInputTool.ts";
import type { UserAnswers } from "../runtime/userInput.ts";
import { runLimits, runtimeLogger, type RunLimits } from "./hostOperations.ts";
import { createChannelManager, type ConnectorFactories } from "./imChannels/channelManager.ts";
import { ChannelSetupError, createChannelSetup, type ChannelSetupResult, type ChannelSetupRun } from "./imChannels/channelSetup.ts";
import type { ChannelSetupRequest } from "./imChannels/connectChannelTool.ts";
import { redactCredentials } from "./imChannels/redactCredentials.ts";
import { CHANNEL_PLATFORMS, type ChannelPatch, type ChannelPlatform } from "./imChannels/types.ts";
import { createModelGateway } from "./runtime/modelGateway.ts";
import { isolatePiTool } from "./runtime/isolatedPiTools.ts";
import { requireAgentIsolation } from "./runtime/agentProcess.ts";

export { PiApprovalGate } from "./approvalGate.ts";
import {
  agentPreset,
  anthropicBaseUrlForProvider,
  isAgentPresetId,
  type AgentHarnessId,
  type AgentPresetId,
} from "./harnessCatalog.ts";

export type { PiPermissionMode } from "./approvalGate.ts";

export type PiSessionBridge = {
  subscribe(listener: (event: PiWireEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  configure(input: PiRuntimeConfiguration): Promise<void>;
  state(): Promise<Omit<PiRuntimeState, "available" | "cwd" | "running">>;
  newSession(): Promise<void>;
};

export type PiBridgeFactory = (input: {
  cwd: string;
  approvalGate: PiApprovalGate;
  /** Where this conversation's Pi session lives on disk; in memory when omitted. */
  sessionDir?: string;
  onUserInput(request: UserInputRequest): Promise<UserAnswers>;
  /** `connect_channel`: absent when the host has no channel setup (tests, previews). */
  onChannelSetup?(request: ChannelSetupRequest): Promise<ChannelSetupResult>;
}) => Promise<PiSessionBridge>;

export type PiRuntimeController = {
  /** Permission mode a turn gets when its client does not choose one (IM channels). */
  readonly defaultPermissionMode: PiPermissionMode;
  health(): { status: "ok"; activeRuns: number; maxConcurrentRuns: number; uptimeSeconds: number };
  state(conversationId?: string): Promise<PiRuntimeState>;
  configure(input: PiRuntimeConfiguration): Promise<PiRuntimeState>;
  /** `signal` belongs to the caller's stream: aborting it stops this run, and only once the run
   *  holds its slot (a rejected duplicate must not stop the turn already in progress). */
  runPrompt(input: PiPromptInput, onEvent: (event: AgentUXEvent) => void, options?: { signal?: AbortSignal }): Promise<void>;
  /** Stops one conversation's run; every run when no conversation is given. */
  abort(conversationId?: string, runId?: string): Promise<boolean>;
  testProvider(definition: PiProviderDefinition, apiKey?: string): Promise<ProviderProbeResult>;
  /** Saved conversations; `running` marks those with a turn in flight right now. */
  listConversations(query?: string): (ConversationSummary & { running: boolean; activeRunId?: string })[];
  conversationReadErrors(): string[];
  /**
   * Watch a run in flight from event `after` on: the saved events past it first, then live ones.
   * `undefined` when the conversation has nothing running. A watcher leaving never stops the run.
   */
  followRun(conversationId: string, after: number, onEvent: (event: AgentUXEvent) => void): { done: Promise<void>; stop(): void } | undefined;
  getConversation(id: string): (StoredConversation & { incomplete: boolean; activeRunId?: string }) | undefined;
  deleteConversation(id: string): void;
  branchConversation(id: string, beforeRunId: string): ReturnType<ConversationStore["branch"]>;
  /** Answers a held tool call; with a conversation, only that conversation's gate is consulted. */
  resolveApproval(toolCallId: string, decision: PiApprovalDecision, conversationId?: string, runId?: string): boolean;
  resolveUserInput(conversationId: string, requestId: string, answers: unknown): boolean;
  newSession(conversationId?: string): Promise<PiRuntimeState>;
  /** Forgets "always allow" grants: one agent's, or every agent's. */
  clearApprovals(agentPreset?: string): Record<string, string[]>;
  dispose(): void;
};

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
  bridgeFactory?: PiBridgeFactory;
  limits?: RunLimits;
  /** Connecting an IM channel from chat; the host binds it to its channel manager. */
  channelSetup?: (run: ChannelSetupRun) => Promise<ChannelSetupResult>;
}): PiRuntimeController {
  const { cwd } = options;
  const dataDir = options.dataDir ?? defaultDataDir();
  const store = options.store ?? createConversationStore(dataDir);
  const limits = options.limits ?? runLimits();
  const log = runtimeLogger(dataDir);
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
  const secretPaths = defaultSecretPaths();
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
  const gateFor = (conversationId: string) => {
    let gate = approvalGates.get(conversationId);
    if (!gate) {
      gate = new PiApprovalGate({ cwd, secretPaths, protectedPaths, readOnlyPaths, egressContained: sandboxed }, approvalMemory);
      approvalGates.set(conversationId, gate);
    }
    return gate;
  };
  let gatewayPromise: ReturnType<typeof createModelGateway> | undefined;
  const gateway = () => gatewayPromise ??= createModelGateway({ port: sandboxed ? undefined : 0 });
  const modelLease = async (provider: { baseUrl: string; apiKey: string; model: string }, protocol: "openai" | "anthropic", conversationId: string) => {
    // Local gateways existed before Linux isolation; retain that development path. Only HTTPS
    // provider runs use this proxy and its request cap. Sandbox tasks never take this fallback.
    if (!sandboxed && new URL(provider.baseUrl).protocol === "http:") return { ...provider, revoke() {} };
    const slot = runs.get(conversationId);
    const lease = (await gateway()).issue({ ...provider, protocol, maxRequests: limits.modelRequests, maxDurationMs: limits.durationMs,
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
    return createDefaultPiBridge({ ...input, sandboxed, rolePrompt: rolePrompt("assistant", layout, { sandboxed }), sessionId: saved?.piSessionId,
      branch: saved?.branch?.native?.harness === "pi" ? { ...saved.branch.native,
        sessionDir: join(dataDir, "pi-sessions", encodeURIComponent(saved.branch.native.sourceId)) } : undefined,
      hasHistory: saved?.agentPreset === "assistant" && saved.events.length > 0,
      onSessionId: (sessionId, beforeEntryId) => {
        const runId = runs.get(id)?.runId;
        if (runId) store.saveNativeTurn(id, runId, { harness: "pi", sessionId, sourceId: id, beforeEntryId });
        else store.setPiSession(id, sessionId);
      },
      modelLease: (provider, protocol) => modelLease(provider, protocol, id),
    });
  });
  const bridgePromises = new Map<string, Promise<PiSessionBridge>>();
  /** Conversations that have already announced their tool set — see `runPrompt`. */
  const announcedCapabilities = new Set<string>();
  const defaultConversationId = "default";
  const maxConversations = 12;
  /** Runs in flight, one per conversation at most. The sandbox has 2 CPUs, so cap the total. */
  const maxConcurrentRuns = 3;
  type RunSlot = {
    runId: string;
    adapter?: PiEventAdapter;
    stop?: () => Promise<void>;
    stopRequested: boolean;
    limit?: string;
    /** Browsers watching the run; it keeps going with none (a closed tab does not stop it). */
    watchers: Set<(event: AgentUXEvent) => void>;
    done: Promise<void>;
  };
  const runs = new Map<string, RunSlot>();
  const askUser = async (conversationId: string, { toolCallId, questions, signal }: UserInputRequest) => {
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
    const adapter = runs.get(conversationId)?.adapter;
    if (!adapter || !options.channelSetup) throw new Error("Channel setup is not available in this run.");
    return options.channelSetup({ conversationId, platform, signal,
      announce: (requestId, state) => adapter.apply({ type: "channel_setup", requestId, toolCallId, state }),
      resolved: (requestId) => adapter.apply({ type: "channel_setup_resolved", requestId, toolCallId }),
    });
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
  const providerDefinitions = new Map<string, PiProviderDefinition>();
  const providerKeys = new Map<string, string>();
  /** Product conversation → the CLI's own session id, so follow-up turns resume it. */
  const cliSessions = new Map<string, { harness: AgentHarnessId; id: string }>();

  const bridge = (conversationId = activeConversationId) => {
    const id = normalizeConversationId(conversationId);
    activeConversationId = id;
    const existing = bridgePromises.get(id);
    if (existing) {
      bridgePromises.delete(id);
      bridgePromises.set(id, existing);
      return existing;
    }
    const created = bridgeFactory({ cwd, approvalGate: gateFor(id), sessionDir: join(dataDir, "pi-sessions", encodeURIComponent(id)), onUserInput: (request) => askUser(id, request),
      ...(options.channelSetup ? { onChannelSetup: (request: ChannelSetupRequest) => setupChannel(id, request) } : {}) }).catch((error) => {
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
    sessionKeyProviders: [...providerKeys.keys()],
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
  const providerCredentials = (providerId?: string) => {
    const definition = providerId ? providerDefinitions.get(providerId) : undefined;
    if (!definition) return undefined;
    const apiKey = providerKeys.get(definition.id)
      ?? (definition.apiKeyEnvVar ? process.env[definition.apiKeyEnvVar]?.trim() : undefined);
    return { definition, apiKey };
  };

  const codexProvider = (providerId?: string, model?: string) => {
    const credentials = providerCredentials(providerId);
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

  const claudeProvider = (providerId?: string, model?: string) => {
    const definition = providerId ? providerDefinitions.get(providerId) : undefined;
    if (!definition) {
      throw new Error("Claude Code has no model service configured. Save the model service in settings, or switch Claude Code to the local login.");
    }
    const baseUrl = anthropicBaseUrlForProvider(definition);
    if (!baseUrl) throw new Error(`${definition.name} has no Anthropic-compatible endpoint, which Claude Code needs.`);
    const apiKey = providerKeys.get(definition.id)
      ?? (definition.apiKeyEnvVar ? process.env[definition.apiKeyEnvVar]?.trim() : undefined);
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
    const approvalGate = gateFor(conversationId);
    approvalGate.setCwd(cwd);
    approvalGate.setMode(input.permissionMode ?? "request");
    approvalGate.setAgent(isAgentPresetId(input.agentPreset) ? input.agentPreset : "assistant");
    if (input.provider || input.model || input.thinkingLevel) {
      await current.configure({ provider: input.provider, model: input.model, thinkingLevel: input.thinkingLevel });
    }

    const adapter = createPiEventAdapter({
      runId: input.requestId ?? `pi_${randomUUID()}`,
      onEvent,
      requiresApproval: (toolName, args) => toolName !== "ask_user" && approvalGate.requiresApproval(toolName, args),
    });
    const unsubscribe = current.subscribe((event) => {
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
      await current.prompt(modelPrompt);
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
      nativeTurn = harness === "claude-code" ? { harness, sessionId, afterMessageId: id } : { harness, sessionId, turnId: id };
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
      if (harness === "claude-code") {
        if (sandboxed && input.claudeCodeModelSource === "local-login") throw new Error("Sandbox agents require a configured model service; local login is disabled.");
        const provider = input.claudeCodeModelSource === "local-login" ? undefined
          : await modelLease(claudeProvider(input.provider, input.model), "anthropic", conversationId);
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
          appendSystemPrompt: rolePrompt(role, layout, { sandboxed }),
          disallowedTools: agentPreset(role).disallowedTools,
          async onPermission(request) {
            // The planner writes only into the shared directory: plans and handoffs for others.
            if (request.tool.name === "write" && !plannerMayWrite(request.tool.args)) {
              return layout.shared
                ? `The planner may only write inside ${layout.shared}.`
                : "The planner does not write files.";
            }
            if (approvalGate.isRefused(request.tool.name, request.tool.args)) return SECRET_REFUSAL;
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
        const configured = input.codexModelSource === "local-login" ? undefined : codexProvider(input.provider, input.model);
        const provider = configured ? { ...configured, ...await modelLease(configured, "openai", conversationId) } : undefined;
        lease = provider;
        await runCodex({
          onUserInput,
          cwd: runCwd,
          addDirs: sharedDirs,
          prompt: modelPrompt,
          developerInstructions: rolePrompt(role, layout, { sandboxed }),
          permissionMode,
          resumeId,
          forkBeforeTurnId: branch?.harness === "codex" ? branch.beforeTurnId : undefined,
          onNativeTurn,
          signal: run.signal,
          emit,
          onSessionId,
          provider,
          async onPermission(request) {
            if (approvalGate.isRefused(request.tool.name, request.tool.args)) return SECRET_REFUSAL;
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
      await slot.stop?.();
    }));
    return true;
  };

  return {
    state,
    defaultPermissionMode,
    health: () => ({ status: "ok", activeRuns: runs.size, maxConcurrentRuns, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }),
    async configure(input) {
      const conversationId = normalizeConversationId(input.conversationId);
      if (runs.has(conversationId)) throw new Error("Stop this conversation's run before changing its configuration.");
      if (input.providerDefinition) providerDefinitions.set(input.providerDefinition.id, input.providerDefinition);
      if (input.provider && input.apiKey) providerKeys.set(input.provider, input.apiKey);
      else if (input.provider && input.clearApiKey) providerKeys.delete(input.provider);
      const current = await bridge(conversationId);
      await current.configure(input);
      return state(conversationId);
    },
    async runPrompt(input, onEvent, options) {
      const prompt = input.prompt?.trim() ? redactCredentials(input.prompt.trim()) : undefined;
      if (!prompt) throw new Error("Pi prompt is empty.");
      const conversationId = normalizeConversationId(input.conversationId);
      input = { ...input, requestId: input.requestId ?? `run_${randomUUID()}` };
      if (runs.has(conversationId)) throw new Error("This conversation already has a run in progress.");
      if (runs.size >= maxConcurrentRuns) {
        throw new Error(`${maxConcurrentRuns} conversations are already running. Wait for one to finish or stop it.`);
      }
      if (store.get(conversationId)?.turns?.some(turn => turn.runId === input.requestId)) throw new Error("This request id has already been submitted.");
      // Reserved before any await, so a second prompt for the same conversation cannot slip in.
      let settle!: () => void;
      const slot: RunSlot = { runId: input.requestId!, stopRequested: false, watchers: new Set(), done: new Promise<void>((resolve) => { settle = resolve; }) };
      runs.set(conversationId, slot);
      const stopOnSignal = () => void abortRuns(conversationId, slot.runId).catch(() => undefined);
      if (options?.signal?.aborted) stopOnSignal();
      options?.signal?.addEventListener("abort", stopOnSignal, { once: true });
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
      const deadline = setTimeout(() => exceed("duration", "This turn reached its time limit (RAYTONEBOT_RUN_TIMEOUT_MS). Work so far is kept; send \"continue\" to resume."), limits.durationMs);
      deadline.unref();
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
        store.begin(conversationId, role, prompt);
        opened = true;
        const modelPrompt = await promptWithWorkspaceFiles(prompt, input.attachments, role, layout, [dataDir]);
        store.saveTurn(conversationId, { runId: input.requestId!, harness, prompt,
          attachments: input.attachments?.map(({ scope, path, name }) => ({ scope, path, ...(name ? { name } : {}) })) });
        if (harness !== "pi") await runCliPrompt(role, harness, input, conversationId, prompt, record, modelPrompt);
        else await runPiPrompt(input, conversationId, prompt, record, modelPrompt);
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
        clearTimeout(deadline);
        options?.signal?.removeEventListener("abort", stopOnSignal);
        try {
          if (opened && !recorder.finish()) terminalStatus = "error";
        } finally { runs.delete(conversationId); settle(); }
        log("run.ended", { conversationId, harness, status: terminalStatus, durationMs: Date.now() - runStartedAt, outputBytes });
      }
    },
    listConversations: (query) => store.list(query).map((summary) => ({ ...summary, running: runs.has(summary.id), activeRunId: runs.get(summary.id)?.runId })),
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
    getConversation(id) {
      const normalized = normalizeConversationId(id);
      const saved = store.get(normalized);
      // Read-only warning: a failed disk cannot persist its own failure terminal.
      return saved && { ...saved, activeRunId: runs.get(normalized)?.runId, incomplete: !runs.has(normalized) && piCancelledTurnEvents(saved.events).length > 0 };
    },
    deleteConversation(id) {
      if (runs.has(normalizeConversationId(id))) {
        throw new Error("Stop the active run before deleting its conversation.");
      }
      store.remove(normalizeConversationId(id));
    },
    branchConversation(id, beforeRunId) {
      const sourceId = normalizeConversationId(id);
      if (!beforeRunId) throw new ConversationBranchError("beforeRunId is required.", 400);
      if (runs.has(sourceId)) throw new ConversationBranchError("Stop this conversation's run before creating a branch.");
      return store.branch(`branch_${randomUUID()}`, sourceId, beforeRunId);
    },
    async testProvider(definition, apiKey) {
      const key = apiKey?.trim()
        || providerKeys.get(definition.id)
        || (definition.apiKeyEnvVar ? process.env[definition.apiKeyEnvVar]?.trim() : undefined);
      return probeProvider(definition, definition.authMode === "none" ? undefined : key);
    },
    abort: abortRuns,
    resolveUserInput: (conversationId, requestId, answers) => userInputGate.resolve(normalizeConversationId(conversationId), requestId, answers),
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
      if (runs.has(id)) throw new Error("Stop this conversation's run before starting a new session.");
      cliSessions.delete(id);
      store.reset(id);
      const current = await bridge(id);
      await current.newSession();
      // A new session starts with an empty transcript, so its tool set has to be announced
      // again or `CapabilityTray` would stay empty for the rest of the conversation's life.
      announcedCapabilities.delete(id);
      return state(id);
    },
    clearApprovals(agentPreset) {
      approvalMemory.clear(agentPreset);
      return approvalMemory.list();
    },
    dispose() {
      for (const gate of approvalGates.values()) gate.cancelAll();
      for (const pending of bridgePromises.values()) void pending.then((current) => current.dispose());
      bridgePromises.clear();
      announcedCapabilities.clear();
      void gatewayPromise?.then((current) => current.close());
    },
  };
}

export function createPiHttpHost(options: {
  cwd: string;
  appRoot?: string;
  sandboxed?: boolean;
  layout?: WorkspaceLayout;
  dataDir?: string;
  bridgeFactory?: PiBridgeFactory;
  limits?: RunLimits;
  channelFactories?: ConnectorFactories;
}) {
  const layout = options.layout ?? resolveWorkspaceLayout({ fallbackCwd: options.cwd });
  const privatePaths = [options.dataDir ?? defaultDataDir()];
  // Bound below: the setup needs the channel manager, which needs the controller.
  let channelSetup: ReturnType<typeof createChannelSetup> | undefined;
  const controller = createPiRuntimeController({ ...options, layout, channelSetup: (run) => channelSetup!.run(run) });
  const dataDir = options.dataDir ?? defaultDataDir();
  // Only when something talks to this host; the vite plugin creates it on the first request.
  const channels = createChannelManager({ runtime: controller, dataDir, defaultPermissionMode: controller.defaultPermissionMode, log: runtimeLogger(dataDir), factories: options.channelFactories });
  channelSetup = createChannelSetup(channels);

  return {
    controller,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(PI_API_PREFIX)) return false;
      // Defense in depth: the vite plugin guards first; this keeps the controller safe
      // however it is mounted (a cross-origin page must not drive tools in this cwd).
      if (!sameOriginRequestAllowed(req)) {
        sendJson(res, 403, { error: "Cross-origin Pi requests are not allowed." });
        return true;
      }
      setLocalHeaders(res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return true;
      }

      try {
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/health`) {
          sendJson(res, 200, controller.health());
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/files`) {
          const scope = url.searchParams.get("scope");
          if (req.method === "GET") {
            sendJson(res, 200, await listWorkspaceFiles(layout, scope, url.searchParams.get("path") ?? "", privatePaths));
            return true;
          }
          if (req.method === "POST") {
            sendJson(res, 201, await uploadWorkspaceFile(layout, scope, url.searchParams.get("name"), req, privatePaths));
            return true;
          }
        }
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === `${PI_API_PREFIX}/files/download`) {
          const entry = await openWorkspaceFile(layout, url.searchParams.get("scope"), url.searchParams.get("path"), privatePaths);
          await sendWorkspaceFile(req, res, entry);
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/state`) {
          sendJson(res, 200, await controller.state(url.searchParams.get("conversationId") ?? undefined));
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/config`) {
          sendJson(res, 200, await controller.configure(await readJson(req)));
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/channels`) {
          sendJson(res, 200, { channels: channels.list() });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/channels/setup`) {
          // Carries the bot token: answered from the channel store, never logged or put in events.
          const body = await readJson(req);
          const action = body.action;
          const conversationId = stringField(body, "conversationId"), requestId = stringField(body, "requestId");
          if (!conversationId || !requestId || (action !== "submit" && action !== "allow" && action !== "reject" && action !== "skip")) {
            sendJson(res, 400, { error: "conversationId, requestId and a valid action are required." });
          } else {
            try {
              sendJson(res, 200, { state: await channelSetup.answer(normalizeConversationId(conversationId), requestId, action, channelPatch(body).fields) ?? null });
            } catch (error) {
              if (!(error instanceof ChannelSetupError)) throw error;
              sendJson(res, error.status, { error: error.message });
            }
          }
          return true;
        }
        const channelMatch = url.pathname.match(new RegExp(`^${PI_API_PREFIX}/channels/([a-z]+)$`));
        if (req.method === "POST" && channelMatch) {
          const platform = channelMatch[1] as ChannelPlatform;
          if (!CHANNEL_PLATFORMS.includes(platform)) sendJson(res, 404, { error: "Unknown IM channel." });
          else sendJson(res, 200, { channels: channels.update(platform, channelPatch(await readJson(req))) });
          return true;
        }
        const branchMatch = url.pathname.match(new RegExp(`^${PI_API_PREFIX}/conversations/([^/]+)/branch$`));
        if (req.method === "POST" && branchMatch) {
          const body = await readJson(req);
          const result = controller.branchConversation(decodeURIComponent(branchMatch[1]), stringField(body, "beforeRunId") ?? "");
          sendJson(res, 201, { conversationId: result.conversation.id, draft: result.draft });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/abort`) {
          const body = await readJson(req);
          const conversationId = stringField(body, "conversationId"), runId = stringField(body, "runId");
          if (body.conversationId !== undefined && !conversationId?.trim() || body.runId !== undefined && (!runId?.trim() || !conversationId?.trim())) {
            sendJson(res, 400, { error: "A targeted stop requires non-empty conversationId and runId strings." });
          } else if (!await controller.abort(conversationId, runId)) {
            sendJson(res, 409, { error: "This run is no longer active; no other run was stopped." });
          } else sendJson(res, 200, { ok: true });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/approval`) {
          const body = await readJson(req);
          const toolCallId = stringField(body, "toolCallId");
          const decision = approvalDecision(body.decision);
          if (body.runId !== undefined && !stringField(body, "runId")) {
            sendJson(res, 400, { error: "runId must be a non-empty string." });
          } else if (!toolCallId || !decision) {
            sendJson(res, 400, { error: "toolCallId and a valid decision are required." });
          } else if (!controller.resolveApproval(toolCallId, decision, stringField(body, "conversationId"), stringField(body, "runId"))) {
            sendJson(res, 409, { error: "This Pi approval is no longer pending." });
          } else {
            sendJson(res, 200, { ok: true });
          }
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/input`) {
          const body = await readJson(req);
          const conversationId = stringField(body, "conversationId"), requestId = stringField(body, "requestId");
          if (!conversationId || !requestId) sendJson(res, 400, { error: "conversationId and requestId are required." });
          else {
            try {
              if (!controller.resolveUserInput(conversationId, requestId, body.answers)) sendJson(res, 409, { error: "This question was already answered or is no longer pending." });
              else sendJson(res, 200, { ok: true });
            } catch (error) { sendJson(res, 400, { error: errorMessage(error) }); }
          }
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/conversations`) {
          const query = url.searchParams.get("query") ?? undefined;
          if (query && query.length > 200) sendJson(res, 400, { error: "Search query must be at most 200 characters." });
          else {
            const conversations = controller.listConversations(query);
            const page = url.searchParams.has("limit") || url.searchParams.has("cursor")
              ? conversationSearchPage(conversations, query ?? "", Number(url.searchParams.get("limit") ?? 100), url.searchParams.get("cursor") ?? undefined)
              : { conversations };
            sendJson(res, 200, { ...page, unreadable: controller.conversationReadErrors() });
          }
          return true;
        }
        if (req.method === "GET" && url.pathname.startsWith(`${PI_API_PREFIX}/conversations/`) && url.pathname.endsWith("/live")) {
          const id = decodeURIComponent(url.pathname.slice(`${PI_API_PREFIX}/conversations/`.length, -"/live".length));
          const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          const follow = controller.followRun(id, Number.isFinite(after) ? after : 0, (event) => {
            if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
          });
          if (!follow) {
            // Nothing running: the saved conversation is complete; the client reads it instead.
            sendJson(res, 409, { error: "This conversation has no run in progress." });
            return true;
          }
          res.flushHeaders();
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write("\n");
          }, 5_000);
          res.once("close", () => {
            clearInterval(heartbeat);
            follow.stop();
          });
          await follow.done;
          clearInterval(heartbeat);
          follow.stop();
          if (!res.destroyed) res.end();
          return true;
        }
        if (url.pathname.startsWith(`${PI_API_PREFIX}/conversations/`)) {
          const id = decodeURIComponent(url.pathname.slice(`${PI_API_PREFIX}/conversations/`.length));
          if (req.method === "GET") {
            const conversation = controller.getConversation(id);
            if (conversation) sendJson(res, 200, conversation);
            else sendJson(res, 404, { error: "Conversation not found." });
            return true;
          }
          if (req.method === "DELETE") {
            controller.deleteConversation(id);
            sendJson(res, 200, { ok: true });
            return true;
          }
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/provider/test`) {
          const body = await readJson(req);
          const definition = asRecord(body.provider) as unknown as PiProviderDefinition;
          if (typeof definition.id !== "string" || typeof definition.baseUrl !== "string") {
            sendJson(res, 400, { error: "provider.id and provider.baseUrl are required." });
          } else {
            sendJson(res, 200, await controller.testProvider(definition, stringField(body, "apiKey")));
          }
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/approvals/clear`) {
          const body = await readJson(req);
          sendJson(res, 200, { alwaysAllowed: controller.clearApprovals(stringField(body, "agentPreset")) });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/session/new`) {
          const body = await readJson(req);
          sendJson(res, 200, await controller.newSession(stringField(body, "conversationId")));
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/prompt`) {
          const body = await readJson(req);
          const prompt = stringField(body, "prompt")?.trim();
          if (!prompt) {
            sendJson(res, 400, { error: "Pi prompt is required." });
            return true;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.flushHeaders();
          const conversationId = stringField(body, "conversationId");
          const requestId = stringField(body, "requestId");
          // A closed tab, reload or dropped connection leaves the run going; the browser can
          // reattach with GET /conversations/:id/live. Only an explicit stop ends it.
          // Proxies in front of the sandbox drop a response that stays silent; a CLI can go quiet
          // for a while (Codex retrying). Blank lines keep it open and are ignored by the client.
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write("\n");
          }, 5_000);
          res.once("close", () => clearInterval(heartbeat));
          try {
            await controller.runPrompt({
              conversationId,
              requestId,
              prompt,
              attachments: body.attachments as PiPromptInput["attachments"],
              provider: stringField(body, "provider"),
              model: stringField(body, "model"),
              thinkingLevel: stringField(body, "thinkingLevel"),
              permissionMode: permissionMode(body.permissionMode),
              agentPreset: isAgentPresetId(body.agentPreset) ? body.agentPreset : undefined,
              claudeCodeModelSource: body.claudeCodeModelSource === "local-login" ? "local-login" : "provider",
              codexModelSource: body.codexModelSource === "local-login" ? "local-login" : "provider",
            }, (event) => {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            });
          } catch (error) {
            // The 200 headers are already sent. Rejections need a terminal in this stream,
            // but must not be appended to (or stop) the conversation's existing active run.
            for (const event of piErrorTurnEvents({ prompt, message: errorMessage(error), runId: requestId, code: PROMPT_REJECTED })) {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            }
          } finally {
            clearInterval(heartbeat);
          }
          if (!res.destroyed) res.end();
          return true;
        }
        sendJson(res, 404, { error: "Unknown Pi endpoint." });
      } catch (error) {
        if (!res.headersSent) sendJson(res, error instanceof WorkspaceFileError || error instanceof ConversationBranchError || error instanceof SearchPageError ? error.status : errorMessage(error).includes("already active") ? 409 : 500, { error: errorMessage(error) });
        else if (!res.destroyed) res.end();
      }
      return true;
    },
    dispose() {
      channels.dispose();
      controller.dispose();
    },
  };
}

/** Only known fields of the right type; anything else is ignored, never stored. */
function channelPatch(body: Record<string, unknown>): ChannelPatch {
  const fields = asRecord(body.fields);
  const definition = asRecord(asRecord(body.model).definition);
  const model = stringField(asRecord(body.model), "model");
  return {
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    fields: Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 4096)),
    ...(body.access === "open" || body.access === "allowlist" ? { access: body.access } : {}),
    ...(Array.isArray(body.allowUsers) ? { allowUsers: body.allowUsers.filter((id): id is string => typeof id === "string" && id.length <= 200) } : {}),
    ...(isAgentPresetId(body.agentPreset) ? { agentPreset: body.agentPreset } : {}),
    ...(model && typeof definition.id === "string" && typeof definition.baseUrl === "string" && Array.isArray(definition.models)
      ? { model: { model, definition: {
        id: definition.id, name: stringField(definition, "name") ?? definition.id, baseUrl: definition.baseUrl,
        protocol: definition.protocol as PiProviderDefinition["protocol"], models: definition.models.filter((entry): entry is string => typeof entry === "string"),
        authMode: definition.authMode === "none" ? "none" : "required",
        ...(stringField(definition, "apiKeyEnvVar") ? { apiKeyEnvVar: stringField(definition, "apiKeyEnvVar") } : {}),
      } } } : {}),
  };
}

async function createDefaultPiBridge(input: {
  cwd: string; approvalGate: PiApprovalGate; sessionDir?: string; sandboxed: boolean; rolePrompt?: string;
  sessionId?: string | null; hasHistory: boolean; onSessionId(id: string, beforeEntryId: string | null): void;
  branch?: { sessionDir: string; sessionId: string; entryId: string };
  onUserInput(request: UserInputRequest): Promise<UserAnswers>;
  onChannelSetup?(request: ChannelSetupRequest): Promise<ChannelSetupResult>;
  modelLease(provider: { baseUrl: string; apiKey: string; model: string }, protocol: "openai" | "anthropic"): Promise<{ baseUrl: string; apiKey: string; revoke(): void }>;
}): Promise<PiSessionBridge> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const { planTool } = await import("./planTool.ts");
  const { userInputTool } = await import("./userInputTool.ts");
  const { connectChannelTool } = await import("./imChannels/connectChannelTool.ts");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const modelRuntime = await pi.ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
  });
  const { settingsManager, resourceLoader } = await createHostResources(pi, input.cwd, input.rolePrompt ? [input.rolePrompt] : []);
  const definitions = new Map<string, PiProviderDefinition>();
  const keys = new Map<string, string>();
  let stopEpoch = 0;
  let session = await createSession(false);
  if (input.branch && !input.sessionId) input.onSessionId(session.sessionId, session.sessionManager.getLeafId());
  let sessionStarted = Boolean(input.sessionId || input.branch || (input.sessionId === undefined && input.hasHistory));
  const assertContext = () => { if (sessionStarted && input.sessionDir) assertPiSessionFile(session.sessionFile, session.sessionId); };
  const prompt = (text: string) => session.prompt(text, { preflightResult(disposition) {
    if (disposition !== "started") return;
    // Bind before the SDK can call the model or tools; configuration failures leave null intact.
    input.onSessionId(session.sessionId, session.sessionManager.getLeafId());
    sessionStarted = true;
  } });

  async function createSession(fresh: boolean) {
    const definitions = [
      pi.createReadToolDefinition(input.cwd),
      pi.createBashToolDefinition(input.cwd, {
        spawnHook: (context) => ({ ...context, env: scrubSecretEnv(context.env) }),
      }),
      pi.createEditToolDefinition(input.cwd),
      pi.createWriteToolDefinition(input.cwd),
      pi.createGrepToolDefinition(input.cwd),
      pi.createFindToolDefinition(input.cwd),
      pi.createLsToolDefinition(input.cwd),
    ].map((definition) => guardTool(isolatePiTool(definition, input.cwd), input.approvalGate)) as ToolDefinition<any, any, any>[];
    definitions.push(planTool, userInputTool(input.onUserInput));
    if (input.onChannelSetup) definitions.push(connectChannelTool(input.onChannelSetup));
    const result = await pi.createAgentSession({
      cwd: input.cwd,
      modelRuntime,
      sessionManager: await openPiSession(pi, fresh ? { ...input, sessionId: null, hasHistory: false, branch: undefined } : input),
      settingsManager,
      resourceLoader,
      noTools: "builtin",
      customTools: definitions,
    });
    return result.session;
  }

  return {
    subscribe(listener) {
      return session.subscribe((event) => listener(event as unknown as PiWireEvent));
    },
    async prompt(text) {
      assertContext();
      const epoch = stopEpoch;
      if (input.sandboxed) requireAgentIsolation();
      const selected = session.model;
      const definition = selected ? definitions.get(selected.provider) : undefined;
      if (!definition || !selected || !["openai-compatible", "anthropic"].includes(definition.protocol) || !definition.baseUrl.startsWith("https:")) {
        if (input.sandboxed) throw new Error("Sandbox Pi requires a configured HTTPS OpenAI-compatible or Anthropic model service.");
        return prompt(text);
      }
      const apiKey = keys.get(definition.id) ?? (definition.authMode === "none" ? "agentcanvas-no-auth"
        : definition.apiKeyEnvVar ? process.env[definition.apiKeyEnvVar] : undefined);
      if (!apiKey) throw new Error("The configured model service has no API key.");
      const lease = await input.modelLease({ baseUrl: definition.baseUrl, apiKey, model: selected.id }, definition.protocol === "anthropic" ? "anthropic" : "openai");
      try {
        registerEditorProvider(modelRuntime, { ...definition, baseUrl: lease.baseUrl, authMode: "required", apiKeyEnvVar: undefined }, selected.provider, selected.id);
        await modelRuntime.setRuntimeApiKey(definition.id, lease.apiKey);
        await session.setModel(modelRuntime.getModel(definition.id, selected.id)!);
        // A stop during async lease/model setup must not launch a new SDK turn afterwards.
        if (epoch !== stopEpoch) throw new Error("Pi run was stopped before the model request.");
        await prompt(text);
      } finally {
        lease.revoke();
        registerEditorProvider(modelRuntime, definition, selected.provider, selected.id);
        if (definition.authMode === "none" && !keys.has(definition.id)) await modelRuntime.removeRuntimeApiKey(definition.id);
        else await modelRuntime.setRuntimeApiKey(definition.id, apiKey);
        await session.setModel(modelRuntime.getModel(definition.id, selected.id)!);
      }
    },
    abort() {
      stopEpoch++;
      return session.abort();
    },
    dispose() {
      stopEpoch++;
      session.dispose();
    },
    async configure(config) {
      assertContext();
      if (config.providerDefinition) {
        registerEditorProvider(modelRuntime, config.providerDefinition, config.provider, config.model);
        definitions.set(config.providerDefinition.id, config.providerDefinition);
      }
      if (config.provider) {
        if (config.apiKey) {
          keys.set(config.provider, config.apiKey);
          await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
        }
        else if (config.clearApiKey) {
          keys.delete(config.provider);
          try {
            await modelRuntime.removeRuntimeApiKey(config.provider);
          } catch (error) {
            // removeRuntimeApiKey clears the in-memory key before Pi refreshes availability.
            // A provider that relies on an env var which is not present in this process then
            // reports "No API key" during that refresh. Configuration is still valid and the
            // exact model can be selected; the later prompt will surface the missing credential.
            if (!isMissingPiCredentialError(error)) throw error;
          }
        }
      }
      if (config.provider || config.model) {
        const provider = config.provider ?? session.model?.provider;
        const modelId = config.model ?? session.model?.id;
        const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
        if (!model) throw new Error(`Pi model not found: ${provider ?? "provider"}/${modelId ?? "model"}`);
        await session.setModel(model);
      }
      if (config.thinkingLevel) session.setThinkingLevel(normalizeThinkingLevel(config.thinkingLevel));
    },
    async state() {
      let availableModels: readonly { provider: string; id: string }[] = [];
      try {
        availableModels = await modelRuntime.getAvailable();
      } catch (error) {
        // The selected editor model remains a valid runtime choice even before its session key
        // is entered. Report it as unavailable instead of making the whole Pi state endpoint
        // fail and exposing whichever default model the session previously used.
        if (!isMissingPiCredentialError(error)) throw error;
      }
      const available = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
      const currentKey = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
      // Pi knows about a large catalog. Sending every unavailable entry on each UI refresh made
      // the state endpoint needlessly huge and exposed choices that could never run. Keep the
      // configured models plus the current selection (which may be backed by an env key that Pi's
      // availability probe cannot see yet).
      const models: PiModelInfo[] = modelRuntime.getModels()
        .filter((model) => available.has(`${model.provider}/${model.id}`) || `${model.provider}/${model.id}` === currentKey)
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          available: available.has(`${model.provider}/${model.id}`),
        }));
      return {
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        provider: session.model?.provider,
        model: session.model?.id,
        thinkingLevel: session.thinkingLevel,
        models,
        tools: session.getActiveToolNames(),
      };
    },
    async newSession() {
      const selected = session.model
        ? { provider: session.model.provider, model: session.model.id, thinkingLevel: session.thinkingLevel }
        : undefined;
      session.dispose();
      session = await createSession(true);
      sessionStarted = false;
      if (selected) {
        const model = modelRuntime.getModel(selected.provider, selected.model);
        if (!model) throw new Error(`Pi model not found after starting a new session: ${selected.provider}/${selected.model}`);
        await session.setModel(model);
        session.setThinkingLevel(normalizeThinkingLevel(selected.thinkingLevel));
      }
    },
  };
}

type PiModelRuntime = Awaited<ReturnType<typeof import("@earendil-works/pi-coding-agent")["ModelRuntime"]["create"]>>;

/** Register the editor model verbatim so Pi never substitutes a similarly named catalog model. */
export function registerEditorProvider(
  modelRuntime: Pick<PiModelRuntime, "registerProvider" | "unregisterProvider">,
  definition: PiProviderDefinition,
  selectedProvider?: string,
  selectedModel?: string,
): void {
  const id = definition.id.trim();
  const baseUrl = definition.baseUrl.trim();
  const models = [...new Set(definition.models.map((model) => model.trim()).filter(Boolean))];
  if (!id) throw new Error("Pi provider id is required.");
  if (selectedProvider && selectedProvider !== id) {
    throw new Error(`Pi provider definition mismatch: expected ${selectedProvider}, received ${id}.`);
  }
  if (!baseUrl) throw new Error(`Pi base URL is required for ${definition.name || id}.`);
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Pi provider URL must use HTTP or HTTPS: ${baseUrl}`);
  }
  if (models.length === 0) throw new Error(`Pi provider ${definition.name || id} has no models.`);
  if (selectedModel && !models.includes(selectedModel)) {
    throw new Error(`Pi model ${selectedModel} is not configured for ${definition.name || id}.`);
  }

  // registerProvider merges omitted fields on re-registration. Unregister first so changing an
  // editor provider cannot retain a stale endpoint, model list, or credential fallback.
  modelRuntime.unregisterProvider(id);
  modelRuntime.registerProvider(id, {
    name: definition.name.trim() || id,
    baseUrl,
    api: piApiForProtocol(definition.protocol),
    apiKey: definition.authMode === "none"
      ? "agentcanvas-no-auth"
      : definition.apiKeyEnvVar
        ? `$${definition.apiKeyEnvVar}`
        : undefined,
    models: models.map((model) => ({
      id: model,
      name: model,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    })),
  });
}

function piApiForProtocol(protocol: PiProviderDefinition["protocol"]): "anthropic-messages" | "openai-completions" {
  return protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function guardTool<T extends { name: string; execute: (...args: any[]) => Promise<any> }>(definition: T, gate: PiApprovalGate): T {
  const execute = definition.execute.bind(definition);
  return {
    ...definition,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, ...rest: unknown[]) {
      await gate.wait(toolCallId, definition.name, params, signal);
      return execute(toolCallId, params, signal, ...rest);
    },
  } as T;
}

function permissionMode(value: unknown): PiPermissionMode {
  return value === "auto" || value === "allow-all" ? value : "request";
}

function approvalDecision(value: unknown): PiApprovalDecision | undefined {
  return value === "yes" || value === "always" || value === "no" ? value : undefined;
}

function normalizeThinkingLevel(value: string): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) return value as ReturnType<typeof normalizeThinkingLevel>;
  return "medium";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Pi request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pi request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function setLocalHeaders(res: ServerResponse) {
  // Intentionally no CORS opt-in. The browser client is same-origin with Vite; allowing another
  // origin to call these endpoints would let an unrelated page drive tools in this cwd.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function normalizeConversationId(value: string | undefined): string {
  const id = value?.trim();
  if (!id) return "default";
  if (id === "." || id === ".." || id.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw new Error("Pi conversationId is invalid.");
  }
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown Pi error");
}

function isMissingPiCredentialError(error: unknown): boolean {
  return /(?:no api key|provider is not configured)/i.test(errorMessage(error));
}
