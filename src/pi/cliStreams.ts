import type { PiWireEvent } from "../harness/adapters/piAdapter.ts";
import { createClaudeTaskPlan } from "./claudeTaskPlan.ts";

/**
 * Translate CLI harness output into Pi's session-event vocabulary.
 *
 * Pi events are what `piAdapter` already turns into AgentUX events — text and reasoning
 * blocks, the full tool lifecycle, approvals, file artifacts. Feeding Claude Code and Codex
 * through the same adapter keeps every engine on one rendering path; nothing here knows about
 * the UI. Pure functions only: the process side lives in `cliHarness.ts`.
 *
 * Formats were captured from the real CLIs on 2026-10-03 (Claude Code 2.1.287
 * `stream-json --include-partial-messages`, Codex CLI 0.153.4 `exec --json`).
 */

type Emit = (event: PiWireEvent) => void;
type Json = Record<string, unknown>;

/** Tool name and arguments as Pi spells them, so titles, approvals and artifacts line up. */
export type NormalizedTool = { name: string; args: Json };

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
};

export function normalizeClaudeTool(name: string, input: unknown): NormalizedTool {
  const raw = asRecord(input);
  const mapped = CLAUDE_TOOL_NAMES[name];
  if (!mapped) return { name, args: raw };
  const { file_path: filePath, notebook_path: notebookPath, old_string: oldText, new_string: newText, ...rest } = raw;
  const path = stringValue(filePath) ?? stringValue(notebookPath);
  return {
    name: mapped,
    args: {
      ...rest,
      ...(path ? { path } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
  };
}

type ClaudeBlock = { kind: "text" | "thinking" | "tool"; toolId?: string; toolName?: string; json: string };

export type ClaudeStreamTranslator = {
  /** Feed one parsed stdout line (control requests are handled by the caller). */
  push(line: Json): void;
  /**
   * Announce execution of a call. Returns false when it was already announced. `fallback`
   * names a call this stream never showed (a subagent's), so its card is still readable.
   */
  startExecution(toolCallId: string, fallback?: NormalizedTool): boolean;
  executionStarted(toolCallId: string): boolean;
  readonly sessionId: string | undefined;
  /** Set when the CLI reported a failed turn. */
  readonly failure: string | undefined;
};

export function createClaudeStreamTranslator(emit: Emit, initialTaskPlan?: unknown): ClaudeStreamTranslator {
  const updateTaskPlan = createClaudeTaskPlan(initialTaskPlan);
  let sessionId: string | undefined;
  let failure: string | undefined;
  const blocks = new Map<number, ClaudeBlock>();
  const streamedMessages = new Set<string>();
  const tools = new Map<string, NormalizedTool>();
  const started = new Set<string>();
  let stopReason: string | undefined;

  const update = (assistantMessageEvent: Json) => emit({ type: "message_update", assistantMessageEvent });

  const startExecution = (toolCallId: string, fallback?: NormalizedTool) => {
    if (started.has(toolCallId)) return false;
    started.add(toolCallId);
    const tool = tools.get(toolCallId) ?? fallback;
    emit({ type: "tool_execution_start", toolCallId, toolName: tool?.name ?? "tool", args: tool?.args });
    return true;
  };

  const rememberTool = (id: string, name: string, input: unknown) => {
    const tool = normalizeClaudeTool(name, input);
    tools.set(id, tool);
    return tool;
  };

  const handleStreamEvent = (event: Json) => {
    const type = stringValue(event.type);
    const index = typeof event.index === "number" ? event.index : 0;
    if (type === "message_start") {
      const id = stringValue(asRecord(event.message).id);
      if (id) streamedMessages.add(id);
      blocks.clear();
      stopReason = undefined;
      emit({ type: "message_start", message: { role: "assistant" } });
    } else if (type === "content_block_start") {
      const block = asRecord(event.content_block);
      const blockType = stringValue(block.type);
      if (blockType === "text") {
        blocks.set(index, { kind: "text", json: "" });
        update({ type: "text_start", contentIndex: index });
      } else if (blockType === "thinking") {
        blocks.set(index, { kind: "thinking", json: "" });
        update({ type: "thinking_start", contentIndex: index });
      } else if (blockType === "tool_use") {
        const toolId = stringValue(block.id) ?? `claude_tool_${tools.size + 1}`;
        const toolName = stringValue(block.name) ?? "tool";
        const tool = rememberTool(toolId, toolName, block.input);
        blocks.set(index, { kind: "tool", toolId, toolName, json: "" });
        update({ type: "toolcall_start", id: toolId, toolName: tool.name, contentIndex: index });
      }
    } else if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const block = blocks.get(index);
      const deltaType = stringValue(delta.type);
      if (deltaType === "text_delta" && block?.kind === "text") {
        update({ type: "text_delta", contentIndex: index, delta: stringValue(delta.text) ?? "" });
      } else if (deltaType === "thinking_delta" && block?.kind === "thinking") {
        update({ type: "thinking_delta", contentIndex: index, delta: stringValue(delta.thinking) ?? "" });
      } else if (deltaType === "input_json_delta" && block?.kind === "tool") {
        const fragment = stringValue(delta.partial_json) ?? "";
        block.json += fragment;
        // Raw fragments keep Claude's own key names (`file_path`); the normalized arguments
        // replace them at `toolcall_end`.
        if (fragment) update({ type: "toolcall_delta", id: block.toolId, contentIndex: index, delta: fragment });
      }
    } else if (type === "content_block_stop") {
      const block = blocks.get(index);
      if (block?.kind === "text") update({ type: "text_end", contentIndex: index });
      else if (block?.kind === "thinking") update({ type: "thinking_end", contentIndex: index });
      else if (block?.kind === "tool" && block.toolId) {
        const tool = rememberTool(block.toolId, block.toolName ?? "tool", parseJson(block.json) ?? {});
        update({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: { id: block.toolId, name: tool.name, arguments: tool.args },
        });
      }
    } else if (type === "message_delta") {
      stopReason = stringValue(asRecord(event.delta).stop_reason) ?? stopReason;
    } else if (type === "message_stop") {
      emit({ type: "message_end", message: { role: "assistant", stopReason: stopReason ?? "stop" } });
    }
  };

  /** A complete assistant message that was not streamed (no partial events for its id). */
  const handleWholeAssistant = (message: Json) => {
    const content = Array.isArray(message.content) ? message.content : [];
    emit({ type: "message_start", message: { role: "assistant" } });
    content.forEach((value, index) => {
      const block = asRecord(value);
      const blockType = stringValue(block.type);
      if (blockType === "text") {
        update({ type: "text_start", contentIndex: index });
        update({ type: "text_delta", contentIndex: index, delta: stringValue(block.text) ?? "" });
        update({ type: "text_end", contentIndex: index });
      } else if (blockType === "thinking") {
        update({ type: "thinking_start", contentIndex: index });
        update({ type: "thinking_delta", contentIndex: index, delta: stringValue(block.thinking) ?? "" });
        update({ type: "thinking_end", contentIndex: index });
      } else if (blockType === "tool_use") {
        const toolId = stringValue(block.id) ?? `claude_tool_${tools.size + 1}`;
        const tool = rememberTool(toolId, stringValue(block.name) ?? "tool", block.input);
        update({ type: "toolcall_start", id: toolId, toolName: tool.name, contentIndex: index });
        update({ type: "toolcall_end", contentIndex: index, toolCall: { id: toolId, name: tool.name, arguments: tool.args } });
      }
    });
    emit({ type: "message_end", message: { role: "assistant", stopReason: stringValue(message.stop_reason) ?? "stop" } });
  };

  const handleToolResults = (message: Json, receipt: unknown) => {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const value of content) {
      const block = asRecord(value);
      if (stringValue(block.type) !== "tool_result") continue;
      const toolCallId = stringValue(block.tool_use_id);
      if (!toolCallId) continue;
      const tool = tools.get(toolCallId);
      // Claude attaches one structured receipt to a result line, outside message.content.
      const result = content.length === 1 ? asRecord(receipt) : {};
      const isError = block.is_error === true || (tool?.name === "TaskUpdate" && result.success === false);
      // Read-only calls run without a permission prompt, so their result is the first sign
      // of execution.
      startExecution(toolCallId);
      emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: tools.get(toolCallId)?.name ?? "tool",
        result: { content: [{ type: "text", text: toolResultText(block.content) }] },
        isError,
      });
      if (tool && !isError) {
        const plan = updateTaskPlan(tool.name, tool.args, result);
        if (plan) emit({ type: "plan_update", plan });
      }
      if (tool?.name === "TodoWrite" && !isError && Array.isArray(tool.args.todos)) {
        emit({ type: "plan_update", plan: tool.args.todos.map((value) => {
          const todo = asRecord(value);
          return { step: todo.content, status: todo.status };
        }) });
      }
    }
  };

  return {
    push(line) {
      const type = stringValue(line.type);
      // A subagent (Task) reports through its parent's tool result; its own stream is not
      // the main reply and its tool ids never reach the main transcript.
      if (line.parent_tool_use_id != null) return;
      if (type === "system") {
        if (stringValue(line.subtype) === "init") sessionId = stringValue(line.session_id) ?? sessionId;
        return;
      }
      if (type === "stream_event") {
        handleStreamEvent(asRecord(line.event));
        return;
      }
      if (type === "assistant") {
        const message = asRecord(line.message);
        const id = stringValue(message.id);
        if (!id || !streamedMessages.has(id)) handleWholeAssistant(message);
        return;
      }
      if (type === "user") {
        handleToolResults(asRecord(line.message), line.tool_use_result);
        return;
      }
      if (type === "result") {
        sessionId = stringValue(line.session_id) ?? sessionId;
        if (stringValue(line.subtype) !== "success" || line.is_error === true) {
          const errors = Array.isArray(line.errors) ? line.errors.map(String).join("\n") : undefined;
          failure = errors || stringValue(line.result) || "Claude Code turn failed.";
        }
      }
    },
    startExecution,
    executionStarted: (toolCallId) => started.has(toolCallId),
    get sessionId() {
      return sessionId;
    },
    get failure() {
      return failure;
    },
  };
}

export type CodexStreamTranslator = {
  push(line: Json): void;
  startExecution(toolCallId: string, tool: NormalizedTool): boolean;
  readonly sessionId: string | undefined;
  readonly failure: string | undefined;
};

export function createCodexStreamTranslator(emit: Emit): CodexStreamTranslator {
  let sessionId: string | undefined;
  let failure: string | undefined;
  /** Top-level `error` lines include retry notices, so only `turn.failed` fails the turn. */
  let lastError: string | undefined;
  const started = new Set<string>();

  const message = (kind: "text" | "thinking", text: string) => {
    if (!text) return;
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_start`, contentIndex: 0 } });
    emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: text } });
    emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_end`, contentIndex: 0 } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  };

  const start = (id: string, tool: NormalizedTool) => {
    if (started.has(id)) return false;
    started.add(id);
    emit({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args: tool.args });
    return true;
  };

  const end = (id: string, tool: NormalizedTool, text: string, isError: boolean) => {
    start(id, tool);
    emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: tool.name,
      result: { content: [{ type: "text", text }] },
      isError,
    });
  };

  const handleItem = (phase: "started" | "updated" | "completed", item: Json) => {
    const itemType = stringValue(item.type);
    const id = stringValue(item.id) ?? `codex_item_${started.size + 1}`;
    const status = stringValue(item.status);
    const failed = status === "failed" || status === "declined";
    if (itemType === "todo_list") {
      if (!failed && Array.isArray(item.items)) emit({ type: "plan_update", plan: item.items.map((value) => {
        const todo = asRecord(value);
        return { step: todo.text, status: typeof todo.completed === "boolean" ? (todo.completed ? "completed" : "pending") : undefined };
      }) });
      return;
    }
    if (itemType === "agent_message") {
      if (phase === "completed") message("text", stringValue(item.text) ?? "");
      return;
    }
    if (itemType === "reasoning") {
      if (phase === "completed") message("thinking", stringValue(item.text) ?? "");
      return;
    }
    const tool = codexTool(itemType, item);
    if (!tool) return;
    if (phase !== "completed") {
      start(id, tool);
      return;
    }
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    const isError = failed || (exitCode !== undefined && exitCode !== 0) || item.error != null;
    end(id, tool, codexToolOutput(itemType, item), isError);
  };

  return {
    startExecution: start,
    push(line) {
      const type = stringValue(line.type);
      if (type === "thread.started") sessionId = stringValue(line.thread_id) ?? sessionId;
      else if (type === "turn.started") emit({ type: "agent_start" });
      else if (type === "item.started") handleItem("started", asRecord(line.item));
      else if (type === "item.updated") handleItem("updated", asRecord(line.item));
      else if (type === "item.completed") handleItem("completed", asRecord(line.item));
      else if (type === "turn.failed") failure = stringValue(asRecord(line.error).message) ?? lastError ?? "Codex turn failed.";
      else if (type === "error") lastError = stringValue(line.message) ?? lastError;
    },
    get sessionId() {
      return sessionId;
    },
    get failure() {
      return failure;
    },
  };
}

function codexTool(itemType: string | undefined, item: Json): NormalizedTool | undefined {
  switch (itemType) {
    case "command_execution":
      return { name: "bash", args: { command: displayCommand(stringValue(item.command) ?? "") } };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      const first = changes[0];
      const path = first ? stringValue(first.path) : undefined;
      return {
        name: first && stringValue(first.kind) === "add" && changes.length === 1 ? "write" : "edit",
        args: { ...(path ? { path } : {}), changes },
      };
    }
    case "mcp_tool_call":
      return {
        name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join(".") || "mcp",
        args: asRecord(item.arguments),
      };
    case "web_search":
      return { name: "web_search", args: { query: stringValue(item.query) ?? "" } };
    default:
      // Error notices and future item types carry no tool to show.
      return undefined;
  }
}

function codexToolOutput(itemType: string | undefined, item: Json): string {
  if (itemType === "command_execution") return stringValue(item.aggregated_output) ?? "";
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
    return changes.map((change) => `${stringValue(change.kind) ?? "update"} ${stringValue(change.path) ?? ""}`).join("\n");
  }
  if (item.error != null) return typeof item.error === "string" ? item.error : JSON.stringify(item.error);
  if (item.result !== undefined) return typeof item.result === "string" ? item.result : JSON.stringify(item.result);
  return "";
}

/** Codex wraps commands in the login shell (`/bin/zsh -lc ls`); show what the agent ran. */
export function displayCommand(command: string): string {
  const wrapped = /^\/\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!wrapped) return command;
  const inner = wrapped[1].trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return quoted ? quoted[2] : inner;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((item) => {
      const block = asRecord(item);
      return stringValue(block.text) ?? (stringValue(block.type) === "image" ? "[image]" : "");
    })
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
