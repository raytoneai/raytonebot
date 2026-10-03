import type { AgentUXEvent } from "@agent-ux/protocol";

import type { PiApprovalDecision } from "../harness/adapters/piAdapter.ts";
import type { AgentHarnessStatus, AgentPresetId, ClaudeCodeModelSource } from "./harnessCatalog.ts";

export const PI_API_PREFIX = "/__agentcanvas/pi";

export type PiModelInfo = {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  available: boolean;
};

export type PiRuntimeState = {
  available: boolean;
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  running: boolean;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  models: PiModelInfo[];
  tools: string[];
  /** Agent engines this host can launch; absent on hosts that predate harness selection. */
  harnesses?: AgentHarnessStatus[];
  /** "auto" inside a disposable sandbox VM, "request" elsewhere. */
  defaultPermissionMode?: "request" | "auto" | "allow-all";
  sandboxed?: boolean;
  protectedPaths?: string[];
  /** Per-role working directories and the shared one (paths only). */
  workspace?: { root?: string; shared?: string; agents: Record<string, string> };
  /** Names (never values) of key-like env vars set on the host. */
  envKeys?: string[];
  /** Providers holding a session key in host memory. */
  sessionKeyProviders?: string[];
  error?: string;
};

export type PiProviderProtocol = "openai-compatible" | "anthropic" | "gemini" | "ollama-native";

/** Exact provider definition selected in AgentCanvas and registered into Pi at runtime. */
export type PiProviderDefinition = {
  id: string;
  name: string;
  protocol: PiProviderProtocol;
  baseUrl: string;
  models: string[];
  authMode: "required" | "none";
  apiKeyEnvVar?: string;
};

export type PiRuntimeConfiguration = {
  conversationId?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  apiKey?: string;
  /** Explicitly clear an in-memory key. Omission means "leave the Pi process key unchanged". */
  clearApiKey?: boolean;
  providerDefinition?: PiProviderDefinition;
};

export type PiPromptInput = {
  conversationId?: string;
  prompt: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  permissionMode?: "request" | "auto" | "allow-all";
  /** Preset agent (and so harness) for this turn. Omitted means the Pi assistant. */
  agentPreset?: AgentPresetId;
  claudeCodeModelSource?: ClaudeCodeModelSource;
  codexModelSource?: ClaudeCodeModelSource;
};

export type ProviderTestResult = {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  models: string[];
  error?: string;
};

/** Reach the provider's model list with its key (the session key here, else the host's). */
export async function testProviderConnection(
  provider: PiProviderDefinition,
  apiKey?: string,
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  return requestJson<ProviderTestResult>(fetcher, `${PI_API_PREFIX}/provider/test`, { provider, apiKey });
}

export type StoredConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentPreset: AgentPresetId;
  eventCount: number;
};

export async function listStoredConversations(fetcher: typeof fetch = fetch): Promise<StoredConversationSummary[]> {
  const body = await requestJson<{ conversations: StoredConversationSummary[] }>(fetcher, `${PI_API_PREFIX}/conversations`);
  return body.conversations;
}

export async function getStoredConversation(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<StoredConversationSummary & { events: AgentUXEvent[] }> {
  return requestJson(fetcher, `${PI_API_PREFIX}/conversations/${encodeURIComponent(id)}`);
}

export async function getPiRuntimeState(fetcher: typeof fetch = fetch): Promise<PiRuntimeState> {
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/state`);
}

export async function configurePiRuntime(
  input: PiRuntimeConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<PiRuntimeState> {
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/config`, input);
}

export async function abortPiRun(fetcher: typeof fetch = fetch): Promise<void> {
  await requestJson(fetcher, `${PI_API_PREFIX}/abort`, {});
}

export async function startNewPiSession(
  conversationId?: string,
  fetcher: typeof fetch = fetch,
): Promise<PiRuntimeState> {
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/session/new`, { conversationId });
}

export async function resolvePiApproval(
  toolCallId: string,
  decision: PiApprovalDecision,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await requestJson(fetcher, `${PI_API_PREFIX}/approval`, { toolCallId, decision });
}

/** Stream one real Pi turn. Each line is already an AgentUX event, never a Pi SDK object. */
export async function* runPiTurn(
  input: PiPromptInput,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): AsyncGenerator<AgentUXEvent> {
  const response = await (options.fetcher ?? fetch)(`${PI_API_PREFIX}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(await responseError(response, "Pi prompt failed"));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseEventLine(line);
        if (!event) continue;
        if (event.type === "run.finished" || event.type === "run.error") sawTerminal = true;
        yield event;
      }
    }
    buffer += decoder.decode();
    const event = parseEventLine(buffer);
    if (event) {
      if (event.type === "run.finished" || event.type === "run.error") sawTerminal = true;
      yield event;
    }
    // The server closes the stream cleanly only after a terminal event. A stream that
    // just ends (bridge/configuration failed after the 200 headers were flushed) must
    // not read as a successful turn — surface it as a transport error instead.
    if (!sawTerminal && !options.signal?.aborted) {
      throw new Error("Pi stream ended before a terminal event arrived.");
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestJson<T = Record<string, unknown>>(
  fetcher: typeof fetch,
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await fetcher(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response, "Pi request failed"));
  return response.json() as Promise<T>;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `${fallback}: ${response.status}`;
  } catch {
    return `${fallback}: ${response.status} ${response.statusText}`.trim();
  }
}

function parseEventLine(line: string): AgentUXEvent | undefined {
  const value = line.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return undefined;
    return parsed as AgentUXEvent;
  } catch {
    return undefined;
  }
}
