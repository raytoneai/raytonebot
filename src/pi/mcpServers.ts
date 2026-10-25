import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { McpServerInput, McpServerView } from "./mcpTypes.ts";
import { readSettingsFile } from "./settingsFile.ts";

/**
 * Remote MCP servers the user adds in Settings (ADR-037). The bot process is the MCP client:
 * it holds the tokens, opens the connections and hands each server's tools to all three engines
 * the way it hands over web_search (Pi custom tools, Codex dynamic tools, Claude SDK servers),
 * so no agent process ever sees a token or reaches the server itself. Streamable HTTP only;
 * every call is a "connector" call for the approval gate.
 */

export type HostToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type HostToolImage = { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };
export type HostToolResult = { text: string; isError: boolean; images?: HostToolImage[] };

/** Native model tool content; UI summaries continue to use the text field. */
export function hostToolContent(result: HostToolResult): ({ type: "text"; text: string } | ({ type: "image" } & HostToolImage))[] {
  return [{ type: "text", text: result.text }, ...(result.isError ? [] : result.images ?? []).map(image => ({ type: "image" as const, ...image }))];
}

/** The enabled servers' tools at the start of one run. */
export type McpToolkit = {
  /** `mcp__<server>__<tool>`, for Pi and Codex. */
  specs: HostToolSpec[];
  /** Per server with short tool names, for Claude's SDK servers (Claude adds the same prefix). */
  servers: { id: string; tools: HostToolSpec[] }[];
  run(name: string, args: unknown, signal?: AbortSignal): Promise<HostToolResult>;
};

type McpTool = HostToolSpec & { original: string };
type McpServer = {
  id: string;
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
  createdAt: number;
  tools: McpTool[];
  error?: string;
  checkedAt?: number;
};

export class McpError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

/** The prefix Claude gives SDK tools: `mcp__<server>__<tool>`. Agents' own tools never use it. */
export const MCP_TOOL_PREFIX = "mcp__";
/** Claude's host server for web_search / web_fetch; not a user server. */
const RESERVED_IDS = new Set(["raytone"]);
const PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOLS = 64;
const MAX_NAME = 64;
const MAX_RESULT_CHARS = 50_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/** One Streamable HTTP session: initialize once, then requests carry the session id. */
class McpConnection {
  private session?: string;
  private version?: string;
  private ready?: Promise<void>;
  private nextId = 0;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(url: string, token: string | undefined, fetcher: typeof fetch) {
    this.url = url;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, timeout: number): Promise<Record<string, unknown>> {
    await this.initialize(signal);
    try { return await this.post(method, params, signal, timeout); }
    catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
      // The server forgot the session (restart, expiry): start one more and try once again.
      this.ready = undefined;
      this.session = undefined;
      await this.initialize(signal);
      return await this.post(method, params, signal, timeout);
    }
  }

  private initialize(signal: AbortSignal | undefined) {
    this.ready ??= (async () => {
      const result = await this.post("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "raytonebot", version: "0.1.0" } }, signal, LIST_TIMEOUT_MS, true);
      this.version = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
      await this.post("notifications/initialized", undefined, signal, LIST_TIMEOUT_MS);
    })().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }

  /** A request, or a notification when `params` is undefined (no id, no answer expected). */
  private async post(method: string, params: Record<string, unknown> | undefined, signal: AbortSignal | undefined, timeout: number, opening = false) {
    const id = params === undefined ? undefined : ++this.nextId;
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(this.session ? { "mcp-session-id": this.session } : {}),
          ...(this.version ? { "mcp-protocol-version": this.version } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        // A redirect would carry the token to wherever it points.
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error && error.name === "TimeoutError" ? "it did not answer in time" : "the connection failed";
      throw new McpError(`Could not reach the MCP server: ${reason}.`);
    }
    if (response.status === 404 && this.session && !opening) { await response.body?.cancel(); throw new SessionExpired(); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new McpError("The MCP server rejected the token."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError(opening && (response.status === 404 || response.status === 405)
        ? `The URL did not accept an MCP connection (HTTP ${response.status}). Use the server's Streamable HTTP endpoint, often ending in /mcp.`
        : `The MCP server returned HTTP ${response.status}.`);
    }
    if (opening) this.session = response.headers.get("mcp-session-id") ?? undefined;
    if (id === undefined) { await response.body?.cancel(); return {}; }
    const message = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? await readEventStream(response, id)
      : parseMessage(await readLimited(response));
    const failure = record(message.error);
    if (message.error) throw new McpError(`The MCP server answered with an error: ${String(failure.message ?? "unknown error")}`);
    return record(message.result);
  }
}

class SessionExpired extends Error {}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new McpError("The MCP server's answer is too large."); }
    text += decoder.decode(value, { stream: true });
  }
}

/** The SSE answer to request `id`; progress notifications and other events before it are skipped. */
async function readEventStream(response: Response, id: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new McpError("The MCP server sent an empty event stream.");
  const decoder = new TextDecoder();
  let buffer = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new McpError("The MCP server's answer is too large.");
        buffer += decoder.decode(value, { stream: true });
      }
      const events = buffer.replace(/\r\n?/g, "\n").split("\n\n");
      buffer = done ? "" : events.pop() ?? "";
      for (const event of events) {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const message = parseMessage(data);
        if (message.id === id && ("result" in message || "error" in message)) return message;
      }
      if (done) throw new McpError("The MCP server closed the stream without answering.");
    }
  } finally { void reader.cancel().catch(() => undefined); }
}

function parseMessage(text: string): Record<string, unknown> {
  try { return record(JSON.parse(text)); } catch { throw new McpError("The MCP server's answer is not JSON-RPC."); }
}

/** What the agent reads back: text items as they are, everything else named, not inlined. */
export function mcpResultText(result: Record<string, unknown>): string {
  const parts = (Array.isArray(result.content) ? result.content : []).map(record).map((item) => {
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image" || item.type === "audio") return `[${item.type}: ${String(item.mimeType ?? "unknown type")}, not shown]`;
    if (item.type === "resource") {
      const resource = record(item.resource);
      return typeof resource.text === "string" ? resource.text : `[resource: ${String(resource.uri ?? "")}]`;
    }
    if (item.type === "resource_link") return `[link: ${String(item.name ?? "")} ${String(item.uri ?? "")}]`.replace(/\s+]/, "]");
    return "";
  }).filter(Boolean);
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = parts.join("\n\n") || "(The tool returned no content.)";
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut at ${MAX_RESULT_CHARS} of ${text.length} characters.]` : text;
}

/** `mcp.json` in the bot's data directory (agents cannot read it), 0600, written whole. */
class McpStore {
  private servers: McpServer[] = [];
  private readonly file?: string;
  readonly error?: Error;

  constructor(file?: string) {
    this.file = file;
    const loaded = readSettingsFile<{ servers: McpServer[] }>(file, data => Array.isArray(data.servers) && data.servers.every(server =>
      server && typeof server.id === "string" && typeof server.url === "string" && typeof server.name === "string"
      && Number.isFinite(server.createdAt) && (server.error === undefined || typeof server.error === "string")
      && typeof server.enabled === "boolean" && (server.token === undefined || typeof server.token === "string")
      && Array.isArray(server.tools) && server.tools.every(tool => tool && typeof tool.name === "string" && typeof tool.original === "string"
        && typeof tool.description === "string" && tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema))));
    this.error = loaded.error;
    this.servers = loaded.data?.servers ?? [];
  }

  list() { if (this.error) throw this.error; return this.servers.map((server) => structuredClone(server)); }
  get(id: string) { if (this.error) throw this.error; const server = this.servers.find((item) => item.id === id); return server && structuredClone(server); }

  put(server: McpServer) {
    if (this.error) throw this.error;
    const next = [...this.servers.filter((item) => item.id !== server.id), server].sort((a, b) => a.createdAt - b.createdAt);
    this.save(next);
    this.servers = next;
  }

  remove(id: string) {
    if (this.error) throw this.error;
    const next = this.servers.filter((item) => item.id !== id);
    if (next.length === this.servers.length) return false;
    this.save(next);
    this.servers = next;
    return true;
  }

  private save(servers: McpServer[]) {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

function view(server: McpServer): McpServerView {
  return {
    id: server.id, name: server.name, url: server.url, enabled: server.enabled, hasToken: Boolean(server.token),
    status: !server.enabled ? "off" : server.error ? "error" : "ready",
    tools: server.tools.map((tool) => tool.name),
    ...(server.error ? { error: server.error } : {}),
    ...(server.checkedAt ? { checkedAt: server.checkedAt } : {}),
  };
}

function urlProblem(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return "Enter the server's full URL, e.g. https://example.com/mcp."; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The URL must start with https://.";
  if (url.username || url.password) return "Put the token in the token field, not in the URL.";
  // A token over plain HTTP is readable on the way; only this machine's own servers may use it.
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "Use https:// for a server on another machine.";
  return undefined;
}

/** The server's short id from its name: `GitHub Issues` → `github-issues`. */
function slug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "") || "mcp";
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_IDS.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Tools as the agents see them: names safe for every engine, the server's own name kept for calls. */
function catalog(server: Pick<McpServer, "id" | "name">, listed: Record<string, unknown>[]): McpTool[] {
  const tools: McpTool[] = [];
  const seen = new Set<string>();
  for (const tool of listed) {
    if (typeof tool.name !== "string" || !tool.name) continue;
    const name = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (seen.has(name) || `${MCP_TOOL_PREFIX}${server.id}__${name}`.length > MAX_NAME) continue;
    seen.add(name);
    const { $schema: _schema, ...schema } = record(tool.inputSchema);
    const description = String(tool.description ?? tool.title ?? "").trim().slice(0, 1024);
    tools.push({ name, original: tool.name, description: `[${server.name}] ${description || tool.name}`,
      inputSchema: schema.type === "object" ? schema : { type: "object", properties: {} } });
    if (tools.length >= MAX_TOOLS) break;
  }
  return tools;
}

export function createMcpService(options: {
  dataDir?: string;
  fetcher?: typeof fetch;
  log?(event: string, fields: Record<string, unknown>): void;
  now?(): number;
} = {}) {
  const store = new McpStore(options.dataDir ? join(options.dataDir, "mcp.json") : undefined);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const connections = new Map<string, { key: string; connection: McpConnection }>();

  const connectionFor = (server: McpServer) => {
    const key = `${server.url}\n${server.token ?? ""}`;
    let entry = connections.get(server.id);
    if (!entry || entry.key !== key) {
      entry = { key, connection: new McpConnection(server.url, server.token, fetcher) };
      connections.set(server.id, entry);
    }
    return entry.connection;
  };

  const required = (id: string) => {
    const server = store.get(id);
    if (!server) throw new McpError("MCP server not found.", 404);
    return server;
  };

  /** Lists the server's tools again; a failure is kept on the server and shown in Settings. */
  const refresh = async (id: string): Promise<McpServerView> => {
    const server = required(id);
    let next: McpServer;
    try {
      const listed: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await connectionFor(server).request("tools/list", cursor ? { cursor } : {}, undefined, LIST_TIMEOUT_MS);
        listed.push(...(Array.isArray(result.tools) ? result.tools.map(record) : []));
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      next = { ...server, tools: catalog(server, listed), error: undefined, checkedAt: now() };
      options.log?.("mcp.listed", { serverId: id, tools: next.tools.length });
    } catch (error) {
      connections.delete(id);
      next = { ...server, error: error instanceof Error ? error.message : String(error), checkedAt: now() };
      options.log?.("mcp.list_failed", { serverId: id, error: next.error });
    }
    // Deleted or edited while listing: that newer state wins.
    const current = store.get(id);
    if (!current || current.url !== server.url || current.token !== server.token) return current ? view(current) : view(next);
    store.put({ ...next, enabled: current.enabled, name: current.name });
    return view(store.get(id)!);
  };

  return {
    list: () => store.list().map(view),

    /** Adds a server (no id) or changes one; an enabled server is listed before this returns. */
    async save(id: string | undefined, input: McpServerInput): Promise<McpServerView> {
      const current = id ? required(id) : undefined;
      const name = (input.name ?? current?.name ?? "").trim().replace(/\s+/g, " ");
      const url = (input.url ?? current?.url ?? "").trim();
      if (!name || name.length > 40) throw new McpError("A name of 1-40 characters is required.", 400);
      const problem = urlProblem(url);
      if (problem) throw new McpError(problem, 400);
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new McpError("enabled must be true or false.", 400);
      const token = input.clearToken ? undefined : typeof input.token === "string" && input.token.trim() ? input.token.trim() : current?.token;
      const server: McpServer = current
        ? { ...current, name, url, token, enabled: input.enabled ?? current.enabled,
          // A different address or token makes the old tool list meaningless.
          ...(current.url !== url || current.token !== token ? { tools: [], error: undefined, checkedAt: undefined } : {}) }
        : { id: slug(name, new Set(store.list().map((item) => item.id))), name, url, token, enabled: input.enabled ?? true, createdAt: now(), tools: [] };
      if (!server.token) delete server.token;
      store.put(server);
      options.log?.(current ? "mcp.updated" : "mcp.added", { serverId: server.id });
      return server.enabled ? refresh(server.id) : view(server);
    },

    remove(id: string) {
      if (!store.remove(id)) throw new McpError("MCP server not found.", 404);
      connections.delete(id);
      options.log?.("mcp.removed", { serverId: id });
    },

    refresh,

    /** The enabled servers' tools for one run; servers that failed to list offer nothing. */
    toolkit(serverIds?: readonly string[], allowed: (id: string) => boolean = () => true): McpToolkit | undefined {
      if (store.error) return undefined;
      const servers = store.list().filter((server) => server.enabled && !server.error && server.tools.length && (serverIds === undefined || serverIds.includes(server.id)) && allowed(server.id));
      if (!servers.length) return undefined;
      return {
        specs: servers.flatMap((server) => server.tools.map(({ name, description, inputSchema }) => ({ name: `${MCP_TOOL_PREFIX}${server.id}__${name}`, description, inputSchema }))),
        servers: servers.map((server) => ({ id: server.id, tools: server.tools.map(({ original: _original, ...tool }) => tool) })),
        async run(fullName, args, signal) {
          const server = servers.find((item) => fullName.startsWith(`${MCP_TOOL_PREFIX}${item.id}__`));
          const tool = server?.tools.find((item) => `${MCP_TOOL_PREFIX}${server.id}__${item.name}` === fullName);
          if (!server || !tool) return { text: `Unknown MCP tool: ${fullName}.`, isError: true };
          // The latest saved address and token, in case they changed since the run started.
          const saved = store.get(server.id);
          if (!saved?.enabled || !allowed(server.id)) return { text: `The MCP server "${server.name}" was switched off, removed or is no longer assigned to this Bot.`, isError: true };
          try {
            const result = await connectionFor(saved).request("tools/call", { name: tool.original, arguments: record(args) }, signal, CALL_TIMEOUT_MS);
            return { text: mcpResultText(result), isError: result.isError === true };
          } catch (error) {
            if (signal?.aborted) throw error;
            return { text: error instanceof Error ? error.message : String(error), isError: true };
          }
        },
      };
    },
  };
}

export type McpService = ReturnType<typeof createMcpService>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
