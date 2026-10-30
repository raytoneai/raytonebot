import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiWireEvent } from "../harness/adapters/piAdapter.ts";
import type { PiModelInfo, PiProviderDefinition, PiRuntimeConfiguration, PiRuntimeState } from "./piClient.ts";
import type { PiApprovalGate } from "./approvalGate.ts";
import { assertPiSessionFile, openPiSession } from "./nativeSession.ts";
import { normalizeModelOptions, resolveModelOptions } from "./modelMetadata.ts";
import { deepSeekThinking } from "./runtime/modelGateway.ts";
import { createHostResources } from "./piResources.ts";
import { scrubSecretEnv } from "./runtime/childEnv.ts";
import { isolatePiTool } from "./runtime/isolatedPiTools.ts";
import { requireAgentIsolation } from "./runtime/agentProcess.ts";
import type { HostTools } from "./memories.ts";
import type { McpToolkit } from "./mcpServers.ts";
import type { WebTools } from "./webAccess.ts";
import type { UserInputRequest } from "./userInputTool.ts";
import type { UserAnswers } from "../runtime/userInput.ts";
import type { ChannelSetupRequest } from "./imChannels/connectChannelTool.ts";
import type { ChannelSetupResult } from "./imChannels/channelSetup.ts";
import type { RoutineRequest } from "./routines.ts";
import type { RoutineView } from "./routineTypes.ts";

export type PiSessionBridge = {
  subscribe(listener: (event: PiWireEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  setRolePrompt?(text: string): void;
  steer?(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  configure(input: PiRuntimeConfiguration): Promise<void>;
  state(): Promise<Omit<PiRuntimeState, "available" | "cwd" | "running">>;
  newSession(): Promise<void>;
};

export async function createDefaultPiBridge(input: {
  delegated?: boolean;
  cwd: string; approvalGate: PiApprovalGate; sessionDir?: string; sandboxed: boolean; rolePrompt?: string;
  sessionId?: string | null; hasHistory: boolean; onSessionId(id: string, beforeEntryId: string | null): void;
  onPromptAccepted?(): void;
  branch?: { sessionDir: string; sessionId: string; entryId: string };
  onUserInput(request: UserInputRequest): Promise<UserAnswers>;
  onChannelSetup?(request: ChannelSetupRequest): Promise<ChannelSetupResult>;
  onCreateRoutine?(request: RoutineRequest): Promise<RoutineView>;
  modelLease(provider: { baseUrl: string; apiKey: string; model: string }, protocol: "openai" | "anthropic", thinkingLevel?: string): Promise<{ baseUrl: string; apiKey: string; revoke(): void }>;
  webTools?: WebTools;
  mcpTools?: McpToolkit;
  hostTools?: HostTools;
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
  const { settingsManager, resourceLoader, setAppendSystemPrompt } = await createHostResources(pi, input.cwd, input.rolePrompt ? [input.rolePrompt] : []);
  const definitions = new Map<string, PiProviderDefinition>();
  const keys = new Map<string, string>();
  let stopEpoch = 0;
  let requestedThinkingLevel: string | undefined;
  let session = await createSession(false);
  if (input.branch && !input.sessionId) input.onSessionId(session.sessionId, session.sessionManager.getLeafId());
  let sessionStarted = Boolean(input.sessionId || input.branch || (input.sessionId === undefined && input.hasHistory));
  const assertContext = () => { if (sessionStarted && input.sessionDir) assertPiSessionFile(session.sessionFile, session.sessionId); };
  const prompt = (text: string) => session.prompt(text, { preflightResult(disposition) {
    if (disposition !== "started") return;
    // Bind before the SDK can call the model or tools; configuration failures leave null intact.
    input.onSessionId(session.sessionId, session.sessionManager.getLeafId());
    sessionStarted = true;
    input.onPromptAccepted?.();
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
    definitions.push(planTool);
    if (!input.delegated) definitions.push(userInputTool(input.onUserInput));
    if (input.webTools) {
      const { webPiTools } = await import("./webTool.ts");
      definitions.push(...webPiTools(input.webTools));
    }
    for (const tools of [input.mcpTools, input.hostTools]) {
      if (!tools) continue;
      const { mcpPiTools } = await import("./mcpTool.ts");
      definitions.push(...mcpPiTools(tools).map((definition) => guardTool(definition, input.approvalGate)) as ToolDefinition<any, any, any>[]);
    }
    if (input.onChannelSetup) definitions.push(connectChannelTool(input.onChannelSetup));
    if (input.onCreateRoutine) {
      const { createRoutineTool } = await import("./routineTool.ts");
      definitions.push(createRoutineTool(input.onCreateRoutine));
    }
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
      const lease = await input.modelLease({ baseUrl: definition.baseUrl, apiKey, model: selected.id }, definition.protocol === "anthropic" ? "anthropic" : "openai", requestedThinkingLevel);
      try {
        registerEditorProvider(modelRuntime, { ...definition, baseUrl: lease.baseUrl, authMode: "required", apiKeyEnvVar: undefined }, selected.provider, selected.id, definition.baseUrl);
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
    setRolePrompt(text) {
      setAppendSystemPrompt(text);
      // Pi's public loadout API rebuilds the system prompt without resetting native history.
      session.setActiveToolsByName(session.getActiveToolNames());
    },
    async steer(text) {
      if (session.isIdle) throw new Error("This run is no longer accepting input.");
      const disposition = await session.steer(text);
      if (session.isIdle) {
        session.clearQueue();
        throw new Error("The run ended before input could be confirmed.");
      }
      if (disposition !== "queued") throw new Error("The input was handled by an extension instead of queued.");
    },
    abort() {
      stopEpoch++;
      session.clearQueue();
      return session.abort().finally(() => { session.clearQueue(); });
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
      if (config.thinkingLevel) {
        requestedThinkingLevel = config.thinkingLevel;
        session.setThinkingLevel(normalizeThinkingLevel(config.thinkingLevel));
      }
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
      const selected = session.model && !(session.model.provider === "unknown" && session.model.id === "unknown")
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
  upstreamBaseUrl = definition.baseUrl,
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
  // The lease URL is loopback, so use the original endpoint for provider capabilities.
  const geminiOpenAI = definition.protocol === "openai-compatible"
    && new URL(upstreamBaseUrl).hostname === "generativelanguage.googleapis.com";
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Pi provider URL must use HTTP or HTTPS: ${baseUrl}`);
  }
  if (models.length === 0) throw new Error(`Pi provider ${definition.name || id} has no models.`);
  if (selectedModel && !models.includes(selectedModel)) {
    throw new Error(`Pi model ${selectedModel} is not configured for ${definition.name || id}.`);
  }
  const modelOptions = normalizeModelOptions(definition.modelOptions, models);

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
      ...resolveModelOptions(model, modelOptions, deepSeekThinking(upstreamBaseUrl, model)),
      ...(geminiOpenAI ? { compat: { supportsStore: false } } : {}),
      ...(deepSeekThinking(upstreamBaseUrl, model) ? { compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: true, supportsDeveloperRole: false,
        supportsStore: false, maxTokensField: "max_tokens" as const, requiresReasoningContentOnAssistantMessages: true } } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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


function normalizeThinkingLevel(value: string): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) return value as ReturnType<typeof normalizeThinkingLevel>;
  return "medium";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown Pi error");
}

function isMissingPiCredentialError(error: unknown): boolean {
  return /(?:no api key|provider is not configured)/i.test(errorMessage(error));
}
