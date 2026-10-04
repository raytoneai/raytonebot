import type { AgentUXEvent } from "@agent-ux/protocol";

import type { PiApprovalDecision } from "../harness/adapters/piAdapter.ts";
import type { ChannelPatch, ChannelPlatform, ChannelView } from "./imChannels/types.ts";
import type { AgentHarnessStatus, AgentPresetId, ClaudeCodeModelSource } from "./harnessCatalog.ts";

export const PI_API_PREFIX = "/__agentcanvas/pi";

export async function answerPiQuestion(conversationId: string, requestId: string, answers: import("../runtime/userInput.ts").UserAnswers) {
  await requestJson(fetch, `${PI_API_PREFIX}/input`, { conversationId, requestId, answers }, AbortSignal.timeout(15_000));
}

export type PiFileScope = AgentPresetId | "shared";
export type PiWorkspaceFile = { name: string; path: string; size: number; directory: boolean };
export type PiFileReference = { scope: PiFileScope; path: string; name: string; size: number };
export type PiPromptAttachment = Pick<PiFileReference, "scope" | "path"> & { name?: string };

export async function listPiFiles(scope: PiFileScope, path = "", signal?: AbortSignal): Promise<{ files: PiWorkspaceFile[] }> {
  const timeout = AbortSignal.timeout(15_000);
  return requestJson(fetch, `${PI_API_PREFIX}/files?${new URLSearchParams({ scope, path })}`, undefined,
    signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function uploadPiFile(file: File, scope: PiFileScope, signal?: AbortSignal): Promise<PiFileReference> {
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(`${PI_API_PREFIX}/files?${new URLSearchParams({ scope, name: file.name })}`, {
    method: "POST", body: file, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "content-type": "application/octet-stream" },
  });
  if (!response.ok) throw new PiRequestError(response.status, await responseError(response, "File upload failed"));
  return response.json();
}

export function piFileDownloadUrl(scope: PiFileScope, path: string): string {
  return `${PI_API_PREFIX}/files/download?${new URLSearchParams({ scope, path })}`;
}

/** Reused attachments may have been removed since the original turn. Check before acceptance. */
export async function checkPiAttachment(file: PiPromptAttachment, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetcher(piFileDownloadUrl(file.scope, file.path), {
    method: "HEAD", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new PiRequestError(response.status, `Attachment ${file.name ?? file.path} is unavailable (${response.status}). Restore or remove it before sending.`);
}

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
  /** Credentials: agents are refused, in every mode. */
  secretPaths?: string[];
  protectedPaths?: string[];
  /** Agents read these freely; changing them always asks (the bot's own code). */
  readOnlyPaths?: string[];
  /** "Always allow" grants per agent: tool names. */
  alwaysAllowed?: Record<string, string[]>;
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
  /** Correlates this submission with its stored run after a lost response; never auto-replayed. */
  requestId?: string;
  prompt: string;
  attachments?: PiPromptAttachment[];
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
  snippet?: string;
  textId?: string;
  matches?: import("./conversationSearch.ts").ConversationTextMatch[];
  /** A turn is in flight on the host; reattach with `followPiTurn`. */
  running?: boolean;
  /** Live identity, not a persisted attribute; used to stop only the observed run. */
  activeRunId?: string;
};

export async function listStoredConversations(fetcher: typeof fetch = fetch): Promise<{ conversations: StoredConversationSummary[]; unreadable: string[] }> {
  const body = await requestJson<{ conversations: StoredConversationSummary[]; unreadable?: string[] }>(fetcher, `${PI_API_PREFIX}/conversations`, undefined, AbortSignal.timeout(15_000));
  return { ...body, unreadable: body.unreadable ?? [] };
}

export async function searchStoredConversations(query: string, signal: AbortSignal, fetcher: typeof fetch = fetch, cursor?: string) {
  return requestJson<{ conversations: StoredConversationSummary[]; unreadable: string[]; nextCursor?: string }>(fetcher,
    `${PI_API_PREFIX}/conversations?${new URLSearchParams({ query, limit: "100", ...(cursor ? { cursor } : {}) })}`, undefined,
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
}

export async function getStoredConversation(
  id: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<StoredConversationSummary & { events: AgentUXEvent[]; incomplete?: boolean }> {
  const timeout = AbortSignal.timeout(15_000);
  return requestJson(fetcher, `${PI_API_PREFIX}/conversations/${encodeURIComponent(id)}`, undefined,
    signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function getPiRuntimeState(fetcher: typeof fetch = fetch): Promise<PiRuntimeState> {
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/state`);
}

/** Creates a saved prefix and returns the original submission; never starts the draft. */
export async function branchStoredConversation(id: string, beforeRunId: string, fetcher: typeof fetch = fetch) {
  return requestJson<{ conversationId: string; draft: { prompt: string; attachments: PiPromptAttachment[] } }>(fetcher,
    `${PI_API_PREFIX}/conversations/${encodeURIComponent(id)}/branch`, { beforeRunId }, AbortSignal.timeout(15_000));
}

export async function configurePiRuntime(
  input: PiRuntimeConfiguration,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PiRuntimeState> {
  const timeout = AbortSignal.timeout(15_000);
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/config`, input,
    signal ? AbortSignal.any([signal, timeout]) : timeout);
}

/** Forgets "always allow" grants for one agent, or for every agent. */
export async function clearApprovalMemory(agentPreset?: string, fetcher: typeof fetch = fetch): Promise<Record<string, string[]>> {
  const body = await requestJson<{ alwaysAllowed: Record<string, string[]> }>(fetcher, `${PI_API_PREFIX}/approvals/clear`, { agentPreset });
  return body.alwaysAllowed;
}

export async function listImChannels(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ChannelView[]> {
  const body = await requestJson<{ channels: ChannelView[] }>(fetcher, `${PI_API_PREFIX}/channels`, undefined, signal ?? AbortSignal.timeout(15_000));
  return body.channels;
}

/** Saves one channel; the server reconnects it when credentials or the enabled switch change. */
export async function updateImChannel(platform: ChannelPlatform, patch: ChannelPatch, fetcher: typeof fetch = fetch): Promise<ChannelView[]> {
  const body = await requestJson<{ channels: ChannelView[] }>(fetcher, `${PI_API_PREFIX}/channels/${platform}`, patch, AbortSignal.timeout(15_000));
  return body.channels;
}

/** Answers a `connect_channel` card. `fields` (the token) goes to the channel store only. */
export async function answerChannelSetup(conversationId: string, requestId: string, action: "submit" | "allow" | "reject" | "skip",
  fields?: Record<string, string>, fetcher: typeof fetch = fetch): Promise<void> {
  await requestJson(fetcher, `${PI_API_PREFIX}/channels/setup`, { conversationId, requestId, action, ...(fields ? { fields } : {}) }, AbortSignal.timeout(30_000));
}

/** Stops one conversation's run; other conversations keep running. */
export async function abortPiRun(conversationId?: string, fetcher: typeof fetch = fetch, runId?: string): Promise<void> {
  await requestJson(fetcher, `${PI_API_PREFIX}/abort`, { conversationId, runId }, AbortSignal.timeout(15_000));
}

export async function startNewPiSession(
  conversationId?: string,
  fetcher: typeof fetch = fetch,
): Promise<PiRuntimeState> {
  return requestJson<PiRuntimeState>(fetcher, `${PI_API_PREFIX}/session/new`, { conversationId });
}

/**
 * Answers a held tool call. Resolves `false` when the host says it is no longer pending (409:
 * answered elsewhere or its run ended); throws on transport failures, which are worth a retry.
 */
export async function resolvePiApproval(
  toolCallId: string,
  decision: PiApprovalDecision,
  conversationId?: string,
  runId?: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`${PI_API_PREFIX}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolCallId, decision, conversationId, runId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(await responseError(response, "Pi request failed"));
  return true;
}

/** Stream one real Pi turn. Each line is already an AgentUX event, never a Pi SDK object. */
export async function* runPiTurn(
  input: PiPromptInput,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): AsyncGenerator<AgentUXEvent> {
  const response = await fetchStream(options.fetcher ?? fetch, `${PI_API_PREFIX}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  });
  if (!response.ok) throw new PiRequestError(response.status, await responseError(response, "Pi prompt failed"));
  if (!response.body) throw new Error("Pi prompt response has no event stream.");
  yield* readEventStream(response.body, options.signal);
}

/**
 * Reattach to a turn still running on the host (after a reload, a closed tab or a dropped
 * connection): the events after the first `after`, then live ones until the turn ends.
 * If the run finished during reattachment, reads the remaining events from its saved transcript.
 */
export async function* followPiTurn(
  conversationId: string,
  after: number,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; requestId?: string } = {},
): AsyncGenerator<AgentUXEvent> {
  const response = await fetchStream(options.fetcher ?? fetch,
    `${PI_API_PREFIX}/conversations/${encodeURIComponent(conversationId)}/live?after=${after}`,
    { signal: options.signal },
  );
  if (response.status === 409) {
    const saved = await getStoredConversation(conversationId, options.fetcher, options.signal);
    if (options.requestId && !saved.events.some((event) => event.runId === options.requestId)) {
      throw new PiRequestError(409, "无法确认这条消息已被主机接收；未自动重发，请检查任务后重试。");
    }
    for (const event of saved.events.slice(Math.max(0, after))) {
      if (options.signal?.aborted) return;
      yield event;
    }
    return;
  }
  if (!response.ok || !response.body) throw new PiRequestError(response.status, await responseError(response, "Pi follow failed"));
  let received = !options.requestId;
  for await (const event of readEventStream(response.body, options.signal)) {
    if (event.runId === options.requestId) received = true;
    yield event;
  }
  if (!received && !options.signal?.aborted) {
    throw new PiRequestError(409, "无法确认这条消息已被主机接收；未自动重发，请检查任务后重试。");
  }
}

/** Bound the connection handshake without putting a deadline on a healthy long-running turn. */
async function fetchStream(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Pi connection timed out.")), 15_000);
  try {
    return await fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function* readEventStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentUXEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      // The host sends a heartbeat every 5 seconds even during a quiet model/tool call.
      // A dead connection must not hang here forever and bypass the reconnect budget.
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Pi event stream timed out.")), 15_000); }),
      ]);
      clearTimeout(timer);
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
    if (!sawTerminal && !signal?.aborted) {
      throw new Error("Pi stream ended before a terminal event arrived.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A definitive HTTP rejection differs from a connection failure while a turn may still run. */
export class PiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PiRequestError";
    this.status = status;
  }
}

async function requestJson<T = Record<string, unknown>>(
  fetcher: typeof fetch,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetcher(url, body === undefined ? (signal ? { signal } : undefined) : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new PiRequestError(response.status, await responseError(response, "Pi request failed"));
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
