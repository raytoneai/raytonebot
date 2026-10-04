import { resolve } from "node:path";
import type { PiWireEvent } from "../harness/adapters/piAdapter.ts";
import { createCodexStreamTranslator, displayCommand, type NormalizedTool } from "./cliStreams.ts";
import { userQuestions, type UserAnswers, type UserQuestion } from "../runtime/userInput.ts";

type Json = Record<string, unknown>;
type Send = (message: Json) => void;
export type CodexPermissionRequest = {
  toolCallId: string;
  tool: NormalizedTool;
  startExecution(): boolean;
};

/** Native v2 stdio protocol, checked against `codex app-server generate-ts` (0.153.4). */
export function createCodexAppServer(options: {
  cwd: string;
  addDirs?: readonly string[];
  prompt: string;
  resumeId?: string;
  forkBeforeTurnId?: string;
  model?: string;
  /** The role prompt, sent on start, resume and fork alike so it survives every session change. */
  developerInstructions?: string;
  emit(event: PiWireEvent): void;
  onSessionId(id: string): void;
  onNativeTurn?: (turn: { sessionId: string; id: string }) => void;
  onPermission(request: CodexPermissionRequest): Promise<true | string>;
  onUserInput?: (request: { toolCallId: string; questions: UserQuestion[]; signal: AbortSignal }) => Promise<UserAnswers>;
  signal: AbortSignal;
}) {
  const translator = createCodexStreamTranslator(options.emit);
  const items = new Map<string, Json>();
  const questions = new Map<unknown, AbortController>();
  let finished = false;
  let failure: string | undefined;
  let lastError: string | undefined;
  let threadId: string | undefined;
  let nativeTurnId: string | undefined;
  const rememberTurn = (turn: unknown) => {
    const id = record(turn).id;
    if (threadId && typeof id === "string" && id !== nativeTurnId) {
      options.onNativeTurn?.({ sessionId: threadId, id });
      nativeTurnId = id;
    }
  };
  const initialize = { id: "initialize", method: "initialize", params: {
    clientInfo: { name: "raytonebot", version: "0.1.0" }, capabilities: { experimentalApi: true },
  } };

  const fail = (message: string) => { failure = message; finished = true; };
  const askUser = async (line: Json, send: Send) => {
    const control = new AbortController();
    const signal = AbortSignal.any([options.signal, control.signal]);
    questions.set(line.id, control);
    try {
      const params = record(line.params);
      if (!threadId || params.threadId !== threadId || !params.itemId) throw new Error("Unknown question thread or item.");
      if (!options.onUserInput) throw new Error("User questions are not connected on this host.");
      const answer = await options.onUserInput({ toolCallId: String(params.itemId),
        questions: userQuestions(params.questions, "codex"), signal });
      if (!signal.aborted && !finished) send({ id: line.id, result: {
        answers: Object.fromEntries(Object.entries(answer ?? {}).map(([key, answers]) => [key, { answers }])) } });
    } catch (error) {
      if (!signal.aborted && !finished) send({ id: line.id, error: { code: -32602, message: error instanceof Error ? error.message : "User input failed." } });
    } finally { questions.delete(line.id); }
  };
  const permission = async (line: Json, send: Send) => {
    const params = record(line.params);
    const itemId = String(params.itemId ?? "");
    const item = items.get(itemId);
    const fileChange = line.method === "item/fileChange/requestApproval";
    // A file approval intentionally carries only its item id. Never approve an unknown patch.
    const tool = fileChange ? (item && normalizedTool(item, options.cwd)) : {
      name: "bash", args: { command: displayCommand(String(params.command ?? "")), cwd: params.cwd ?? options.cwd },
    };
    let allowed: true | string = "Missing command or patch details.";
    if (tool && (fileChange || tool.args.command)) {
      try {
        allowed = await options.onPermission({ toolCallId: itemId, tool,
          startExecution: () => translator.startExecution(itemId, tool) });
      } catch (error) { allowed = error instanceof Error ? error.message : "Operation denied."; }
    }
    if (options.signal.aborted || finished) return;
    send({ id: line.id, result: { decision: allowed === true ? "accept" : "decline" } });
  };

  return {
    initialize,
    push(line: Json, send: Send) {
      if (finished || options.signal.aborted) return;
      if (line.id != null && line.method) {
        if (line.method === "item/commandExecution/requestApproval" || line.method === "item/fileChange/requestApproval") {
          void permission(line, send);
        } else if (line.method === "item/tool/requestUserInput") {
          void askUser(line, send);
        } else {
          // No session-wide permission grants or unknown tools bypass the per-action gate.
          send({ id: line.id, error: { code: -32601, message: `Unsupported Codex request: ${String(line.method)}` } });
        }
        return;
      }
      if (line.id != null) {
        if (line.error) { fail(String(record(line.error).message ?? "Codex request failed.")); return; }
        if (line.id === "initialize") {
          send({ method: "initialized" });
          send({ id: "thread", method: options.forkBeforeTurnId ? "thread/fork" : options.resumeId ? "thread/resume" : "thread/start", params: {
            ...(options.resumeId ? { threadId: options.resumeId } : { historyMode: "legacy" }),
            ...(options.forkBeforeTurnId ? { beforeTurnId: options.forkBeforeTurnId } : {}),
            cwd: options.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only",
            runtimeWorkspaceRoots: [options.cwd, ...(options.addDirs ?? [])],
            config: { tools: { update_plan: { enabled: true } }, features: { default_mode_request_user_input: true } },
            ...(options.model ? { model: options.model, modelProvider: "raytonebot" } : {}),
            ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
          } });
        } else if (line.id === "thread") {
          const result = record(line.result);
          threadId = String(record(result.thread).id ?? "");
          if (!threadId) { fail("Codex returned no thread id."); return; }
          options.onSessionId(threadId);
          send({ id: "turn", method: "turn/start", params: { threadId,
            input: [{ type: "text", text: options.prompt, text_elements: [] }] } });
        } else if (line.id === "turn") rememberTurn(record(line.result).turn);
        return;
      }
      const params = record(line.params);
      if (threadId && params.threadId && params.threadId !== threadId) return;
      if (line.method === "serverRequest/resolved") questions.get(params.requestId)?.abort();
      if (line.method === "turn/started") { rememberTurn(params.turn); translator.push({ type: "turn.started" }); }
      else if (line.method === "turn/plan/updated") {
        if (threadId && params.threadId === threadId) options.emit({ type: "plan_update", plan: params.plan, explanation: params.explanation });
      }
      else if (line.method === "item/started" || line.method === "item/completed") {
        const item = record(params.item);
        items.set(String(item.id), item);
        translator.push({ type: line.method === "item/started" ? "item.started" : "item.completed", item: legacyItem(item, options.cwd) });
      } else if (line.method === "turn/completed") {
        const turn = record(params.turn);
        if (turn.status === "failed") fail(String(record(turn.error).message ?? lastError ?? "Codex turn failed."));
        else if (turn.status === "interrupted") fail("Codex turn was interrupted.");
        finished = true;
        for (const question of questions.values()) question.abort();
      } else if (line.method === "error" && params.willRetry !== true) {
        lastError = String(record(params.error).message ?? "Codex turn failed.");
      }
    },
    get finished() { return finished; },
    get failure() { return failure; },
  };
}

function normalizedTool(item: Json, cwd: string): NormalizedTool | undefined {
  if (item.type !== "fileChange") return undefined;
  const changes = (Array.isArray(item.changes) ? item.changes : []).map(record).map((change) => ({
    ...change, path: resolve(cwd, String(change.path)), kind: record(change.kind).type,
    move_path: record(change.kind).move_path,
  }));
  if (!changes.length) return undefined;
  const paths = changes.flatMap((change) => [change.path, ...(typeof change.move_path === "string" ? [resolve(cwd, change.move_path)] : [])]);
  return { name: "edit", args: { path: paths[0], paths, changes } };
}

/** Reuse the existing Pi translation; app-server uses camelCase item names and fields. */
function legacyItem(item: Json, cwd: string): Json {
  if (item.type === "commandExecution") return { ...item, type: "command_execution", aggregated_output: item.aggregatedOutput, exit_code: item.exitCode };
  if (item.type === "fileChange") return { ...item, type: "file_change", changes: normalizedTool(item, cwd)?.args.changes };
  if (item.type === "agentMessage") return { ...item, type: "agent_message" };
  if (item.type === "reasoning") return { ...item, text: [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].join("\n") };
  if (item.type === "mcpToolCall") return { ...item, type: "mcp_tool_call" };
  if (item.type === "webSearch") return { ...item, type: "web_search", query: record(item.action).query };
  return item;
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
