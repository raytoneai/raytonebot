import { isDeepStrictEqual } from "node:util";
import type { PiWireEvent } from "../harness/adapters/piAdapter.ts";
import type { ClaudePermissionRequest } from "./cliHarness.ts";
import type { NormalizedTool } from "./cliStreams.ts";

type Json = Record<string, any>;
type Send = (message: Json) => void;
const object = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** DSH's real argument names, normalized for the shared policy and artifact adapter. */
export function normalizeDshTool(name: string, args: unknown, cwd: string): NormalizedTool | undefined {
  if (!object(args) || !name) return;
  const result = { ...args };
  if (typeof args.file_path === "string") result.path = args.file_path;
  if (typeof args.old_string === "string") result.oldText = args.old_string;
  if (typeof args.new_string === "string") result.newText = args.new_string;
  if (name === "bash") {
    if (typeof args.command !== "string" || !args.command.trim() || args.run_in_background === true) return;
    result.cwd = typeof args.workdir === "string" ? args.workdir : cwd;
  }
  if (["read", "write", "edit"].includes(name) && typeof result.path !== "string") return;
  return { name, args: result };
}

/** Fixed ACP v1 contract from DSH 0.2.1-rc.2; only committed text is rendered. */
export function createDshProtocol(options: {
  cwd: string; prompt: string; resumeId?: string; signal: AbortSignal;
  emit(event: PiWireEvent): void; onSessionId(id: string): void; onAccepted?(): void;
  onPermission(request: ClaudePermissionRequest): Promise<true | string>;
  userInputTools?: readonly string[];
}) {
  let sessionId: string | undefined;
  let finished = false;
  let failure: string | undefined;
  let accepted = false;
  let closing = false;
  const calls = new Map<string, { name: string; args: unknown; tool?: NormalizedTool; started: boolean; done: boolean; requested: boolean; allowed: boolean; consumed: boolean }>();
  const accept = () => { if (!accepted) { accepted = true; options.onAccepted?.(); } };
  const start = (id: string) => {
    const call = calls.get(id);
    if (!call || call.started) return false;
    call.started = true;
    options.emit({ type: "tool_execution_start", toolCallId: id, toolName: call.tool?.name ?? call.name, args: call.tool?.args ?? call.args });
    return true;
  };
  const close = (send: Send) => {
    if (closing) return;
    closing = true;
    if (sessionId) send({ jsonrpc: "2.0", id: "close", method: "session/close", params: { sessionId } });
    else finished = true;
  };
  const permission = async (line: Json, send: Send) => {
    const id = line.params?.toolCall?.toolCallId;
    const call = typeof id === "string" ? calls.get(id) : undefined;
    let allow: true | string = "Unknown or malformed DSH tool call.";
    try {
      if (!options.signal.aborted && line.params?.sessionId === sessionId && call?.tool && !call.done && !call.requested) {
        call.requested = true;
        if (options.userInputTools?.includes(call.name)) { start(id); allow = true; }
        else allow = await options.onPermission({ toolCallId: id, tool: call.tool, startExecution: () => start(id) });
        call.allowed = allow === true && !options.signal.aborted;
      }
    } catch { /* Fail closed; a denied result arrives through the engine. */ }
    send({ jsonrpc: "2.0", id: line.id, result: { outcome: options.signal.aborted ? { outcome: "cancelled" }
      : { outcome: "selected", optionId: allow === true ? "allow-once" : "reject-once" } } });
  };
  return {
    initialize: { jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocolVersion: 1,
      clientInfo: { name: "raytonebot", version: "0.1.0" }, clientCapabilities: {} } },
    get finished() { return finished; },
    get failure() { return failure; },
    cancel(send: Send) {
      if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    },
    /** Each host tool execution consumes exactly one matching, already approved call. */
    takeAuthorization(id: string, name: string, args: unknown, nativeSession: string) {
      const call = calls.get(id);
      if (options.signal.aborted || nativeSession !== sessionId || !call?.allowed || call.consumed || call.done
        || call.name !== name || !isDeepStrictEqual(call.args, args)) return false;
      call.consumed = true;
      return true;
    },
    push(line: Json, send: Send) {
      if (finished) return;
      if (line.method && line.id !== undefined) {
        if (line.method === "session/request_permission") void permission(line, send);
        else send({ jsonrpc: "2.0", id: line.id, error: { code: -32601, message: "Unsupported DSH request." } });
        return;
      }
      if (line.id !== undefined) {
        if (line.error) { failure = String(line.error.message ?? "DSH request failed."); close(send); if (line.id === "close") finished = true; return; }
        if (line.id === "initialize") {
          if (options.signal.aborted) { finished = true; return; }
          send({ jsonrpc: "2.0", id: "session", method: options.resumeId ? "session/resume" : "session/new",
            params: { cwd: options.cwd, mcpServers: [], ...(options.resumeId ? { sessionId: options.resumeId } : {}) } });
        } else if (line.id === "session") {
          const id = line.result?.sessionId;
          // ACP resume can omit the id: its request already identified the exact native session.
          sessionId = typeof id === "string" ? id : options.resumeId;
          if (!sessionId || (options.resumeId && sessionId !== options.resumeId)) { failure = "DSH returned an unexpected session."; close(send); return; }
          options.onSessionId(sessionId);
          if (options.signal.aborted) { close(send); return; }
          options.emit({ type: "agent_start" });
          send({ jsonrpc: "2.0", id: "prompt", method: "session/prompt", params: { sessionId,
            prompt: [{ type: "text", text: options.prompt }] } });
        } else if (line.id === "prompt") {
          if (line.result?.stopReason !== "end_turn" && !options.signal.aborted) failure = `DSH stopped: ${String(line.result?.stopReason ?? "unknown reason")}.`;
          else if (!options.signal.aborted) accept();
          close(send);
        } else if (line.id === "close") finished = true;
        return;
      }
      if (line.method !== "session/update" || line.params?.sessionId !== sessionId) return;
      const update = line.params.update;
      if (!object(update)) return;
      const type = update.sessionUpdate;
      if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
        if (update.content?.type !== "text" || !update.content.text || options.signal.aborted) return;
        accept();
        const kind = type === "agent_message_chunk" ? "text" : "thinking";
        options.emit({ type: "message_start", message: { role: "assistant" } });
        for (const phase of ["start", "delta", "end"]) options.emit({ type: "message_update", assistantMessageEvent: {
          type: `${kind}_${phase}`, contentIndex: 0, ...(phase === "delta" ? { delta: update.content.text } : {}) } });
        options.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      } else if (type === "tool_call") {
        if (typeof update.toolCallId !== "string" || calls.has(update.toolCallId)) return;
        accept();
        const name = typeof update.title === "string" ? update.title : "unknown";
        calls.set(update.toolCallId, { name, args: update.rawInput, tool: normalizeDshTool(name, update.rawInput, options.cwd),
          started: false, done: false, requested: false, allowed: false, consumed: false });
      } else if (type === "tool_call_update" && ["completed", "failed"].includes(update.status)) {
        const call = calls.get(update.toolCallId);
        if (!call || call.done) return;
        start(update.toolCallId);
        call.done = true;
        const text = Array.isArray(update.content) ? update.content.flatMap((part: Json) => part.type === "content" && part.content?.type === "text" ? [part.content.text] : []).join("\n") : "";
        options.emit({ type: "tool_execution_end", toolCallId: update.toolCallId, toolName: call.tool?.name ?? call.name,
          result: { content: [{ type: "text", text }] }, isError: update.status === "failed" });
      }
    },
  };
}
