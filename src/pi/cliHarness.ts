import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { PiWireEvent } from "../harness/adapters/piAdapter.ts";
import type { AgentHarnessId, AgentHarnessStatus } from "./harnessCatalog.ts";
import { createClaudeStreamTranslator, createCodexStreamTranslator, normalizeClaudeTool, type NormalizedTool } from "./cliStreams.ts";
import { scrubSecretEnv } from "./runtime/childEnv.ts";
import { appendRecentStderr, createChildProcessTerminator, RUNTIME_PROCESS_GROUP } from "./runtime/process.ts";

/**
 * Launch Claude Code and Codex CLI for one turn each. Node-only.
 *
 * Launch flags and the Claude stdio permission protocol follow TelegramAgent's runtime
 * adapters (`backend/src/claudeCodeRuntime.ts`, `codexCliRuntime.ts`); the Claude env
 * hardening list follows OpenAgentCore's `claude-sdk-adapter/src/workspace.ts` (MIT).
 */

export type CliPermissionMode = "request" | "auto" | "allow-all";

type CliRunBase = {
  cwd: string;
  prompt: string;
  permissionMode: CliPermissionMode;
  /** The harness's own session id from an earlier turn of this conversation. */
  resumeId?: string;
  signal: AbortSignal;
  emit: (event: PiWireEvent) => void;
  onSessionId: (id: string) => void;
};

export type ClaudePermissionRequest = {
  toolCallId: string;
  tool: NormalizedTool;
  /** Announce the call as executing; false when it already was. */
  startExecution(): boolean;
};

export type ClaudeRunOptions = CliRunBase & {
  /** Anthropic-format endpoint (e.g. DeepSeek). Omitted means the local Claude login. */
  provider?: { baseUrl: string; apiKey: string; model: string };
  appendSystemPrompt?: string;
  disallowedTools?: readonly string[];
  /** Directories outside cwd the agent may use (the shared workspace). */
  addDirs?: readonly string[];
  /** Resolve true to allow; a string denies with that message. */
  onPermission(request: ClaudePermissionRequest): Promise<true | string>;
};

export type CodexRunOptions = CliRunBase & {
  addDirs?: readonly string[];
  /** A Responses-API provider (e.g. DeepSeek). Omitted means Codex's own login. */
  provider?: { name: string; baseUrl: string; apiKey: string; model: string };
  /** `danger-full-access` only inside a disposable VM, where the VM is the boundary. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
};

const CLAUDE_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/** The variables Codex's commands may see (list from TelegramAgent's Codex adapter). */
const CODEX_COMMAND_ENV = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM",
];

/** Tools whose every call goes through RaytoneBot's approval gate. */
const CLAUDE_ASK_TOOLS = ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"];

export function cliCommand(harness: Exclude<AgentHarnessId, "pi">, env: NodeJS.ProcessEnv = process.env): string {
  if (harness === "claude-code") return env.RAYTONEBOT_CLAUDE_BIN?.trim() || "claude";
  return env.RAYTONEBOT_CODEX_BIN?.trim() || "codex";
}

let statusCache: { at: number; value: Promise<AgentHarnessStatus[]> } | undefined;

/** Whether each CLI can launch here. Cached briefly: settings polls it on every open. */
export function detectCliHarnesses(): Promise<AgentHarnessStatus[]> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const probe = (id: Exclude<AgentHarnessId, "pi">) => new Promise<AgentHarnessStatus>((resolve) => {
    execFile(cliCommand(id), ["--version"], { timeout: 8_000 }, (error, stdout) => {
      if (error) resolve({ id, available: false, error: error.message });
      else resolve({ id, available: true, version: stdout.trim().split("\n")[0] });
    });
  });
  const value = Promise.all([probe("claude-code"), probe("codex")]);
  statusCache = { at: Date.now(), value };
  return value;
}

export function buildClaudeArgs(options: Pick<ClaudeRunOptions, "permissionMode" | "resumeId" | "provider" | "appendSystemPrompt" | "disallowedTools" | "addDirs">): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    // Permission prompts arrive as `can_use_tool` control requests on stdout and are answered
    // on stdin, before the tool runs.
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    // The host's own CLAUDE.md, skills, plugins, hooks and MCP servers stay out of product runs.
    "--safe-mode",
    "--strict-mcp-config",
    // RaytoneBot's gate decides every prompt, including "allow all", so the CLI always asks.
    // `ask` rules matter: without them Claude auto-runs commands it judges read-only.
    "--permission-mode", "manual",
    "--settings", JSON.stringify({ permissions: { ask: CLAUDE_ASK_TOOLS } }),
  ];
  if (options.provider) {
    // User settings can carry an `env` block (base URL, token) that outranks the process env
    // and would send a provider run to the host's own endpoint. A provider run loads none.
    args.push("--setting-sources", "", "--model", options.provider.model);
  }
  if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.disallowedTools?.length) args.push("--disallowedTools", ...options.disallowedTools);
  if (options.addDirs?.length) args.push("--add-dir", ...options.addDirs);
  if (options.resumeId) args.push("--resume", options.resumeId);
  return args;
}

/** Markers a parent Claude Code session sets for its own children; a product run is not one. */
const CLAUDE_PARENT_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
] as const;

export function claudeEnv(base: NodeJS.ProcessEnv, provider: ClaudeRunOptions["provider"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    // Background subagents outlive the turn's `result`, after which stdin is closed: every
    // permission request they make then fails ("Stream closed"). Subagents run in the foreground.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
  for (const key of CLAUDE_PARENT_SESSION_ENV_KEYS) delete env[key];
  // "Local login" is whatever this host's Claude Code already authenticates with (keychain
  // login, or a gateway set in its env), so it is inherited untouched. A provider replaces
  // all of it: an inherited API key would otherwise silently win over the provider token.
  if (provider) {
    for (const key of CLAUDE_PROVIDER_ENV_KEYS) delete env[key];
    Object.assign(env, {
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
      ANTHROPIC_MODEL: provider.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.model,
      CLAUDE_CODE_SUBAGENT_MODEL: provider.model,
    });
  }
  return env;
}

/** The env var carrying a provider key into Codex (and only Codex: its commands never see it). */
export const CODEX_PROVIDER_KEY_ENV = "RAYTONEBOT_CODEX_API_KEY";

export function buildCodexArgs(options: Pick<CodexRunOptions, "cwd" | "sandbox" | "resumeId" | "addDirs" | "provider">): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox", options.sandbox,
    "--cd", options.cwd,
    "--skip-git-repo-check",
    // The host's ~/.codex config, rules, plugins and apps stay out of product runs; the login
    // (auth.json) is still used.
    "--ignore-user-config",
    "--ignore-rules",
    "--disable", "plugins",
    "--disable", "apps",
    // Commands Codex runs see only basic variables, never the key Codex itself uses.
    "-c", `shell_environment_policy.inherit="all"`,
    "-c", `shell_environment_policy.include_only=${JSON.stringify(CODEX_COMMAND_ENV)}`,
  ];
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  if (options.provider) {
    // TOML basic strings share JSON's escaping, so JSON.stringify quotes them safely.
    const value = (text: string) => JSON.stringify(text);
    args.push(
      "-c", `model_provider="raytonebot"`,
      "-c", `model=${value(options.provider.model)}`,
      "-c", `model_providers.raytonebot.name=${value(options.provider.name)}`,
      "-c", `model_providers.raytonebot.base_url=${value(options.provider.baseUrl)}`,
      "-c", `model_providers.raytonebot.env_key="${CODEX_PROVIDER_KEY_ENV}"`,
      "-c", `model_providers.raytonebot.wire_api="responses"`,
    );
  }
  // The prompt goes in on stdin (`-`), so its length is not bounded by argv.
  if (options.resumeId) args.push("resume", options.resumeId, "-");
  else args.push("-");
  return args;
}

type JsonLine = Record<string, unknown>;

/** Spawn one CLI turn, hand each stdout JSON line to `onLine`, and settle when it exits. */
async function runCliProcess(params: {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  stdinLines?: unknown[];
  stdinText?: string;
  onLine(line: JsonLine, stdin: NodeJS.WritableStream): void;
  /** Called after each line; true closes stdin (Claude keeps it open for permission replies). */
  isFinished?(): boolean;
}): Promise<void> {
  if (params.signal.aborted) return;
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: RUNTIME_PROCESS_GROUP,
  });
  let exited = false;
  let stderrTail = "";
  let stdinEnded = false;
  const terminate = createChildProcessTerminator(child, () => exited, undefined, { processGroup: true });
  const endInput = () => {
    if (stdinEnded) return;
    stdinEnded = true;
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
  };
  const abort = () => terminate("abort");
  params.signal.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => {
    if (!exited && !params.signal.aborted) terminate();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = appendRecentStderr(stderrTail, chunk);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  for (const line of params.stdinLines ?? []) child.stdin.write(`${JSON.stringify(line)}\n`);
  if (params.stdinText !== undefined) {
    stdinEnded = true;
    child.stdin.end(params.stdinText);
  }

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const text = String(raw).trim();
      if (!text.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      params.onLine(parsed as JsonLine, child.stdin);
      if (params.isFinished?.()) endInput();
    }
    const result = await exit;
    if (params.signal.aborted) return;
    if (result.code !== 0) {
      const detail = stderrTail.trim() ? `\n${stderrTail.trim()}` : "";
      throw new Error(`${params.label} exited with code ${result.code ?? "null"}${result.signal ? ` (${result.signal})` : ""}${detail}`);
    }
  } finally {
    params.signal.removeEventListener("abort", abort);
    lines.close();
    endInput();
    terminate();
  }
}

/**
 * Run a CLI turn and, when it fails, report the CLI's own reason (its `turn.failed` / `result`)
 * instead of an exit code wrapped around a stderr dump.
 */
async function failWithReport(
  translator: { readonly failure: string | undefined },
  run: () => Promise<void>,
  hint?: (failure: string) => string | undefined,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!translator.failure) throw error;
  }
  if (translator.failure) {
    const extra = hint?.(translator.failure);
    throw new Error(extra ? `${translator.failure}\n${extra}` : translator.failure);
  }
}

function codexHint(failure: string): string | undefined {
  if (/401|unauthori[sz]ed|missing bearer/i.test(failure)) {
    return "Codex is not signed in on this host. Run `codex login` there, or set OPENAI_API_KEY for the server.";
  }
  return undefined;
}

function writeLine(stdin: NodeJS.WritableStream, value: unknown) {
  if (("destroyed" in stdin && stdin.destroyed) || !stdin.writable) return;
  stdin.write(`${JSON.stringify(value)}\n`);
}

function controlResponse(stdin: NodeJS.WritableStream, requestId: string, response: Record<string, unknown>) {
  writeLine(stdin, { type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

function isMissingSession(message: string): boolean {
  return /no (conversation|session|thread|rollout)[^\n]*found|not found[^\n]*(session|thread|conversation)/i.test(message);
}

/** One Claude Code turn. Throws with the CLI's own message when the turn fails. */
export async function runClaudeCode(options: ClaudeRunOptions): Promise<void> {
  let emitted = 0;
  const emit = (event: PiWireEvent) => {
    emitted += 1;
    options.emit(event);
  };
  const attempt = async (resumeId: string | undefined) => {
    const translator = createClaudeStreamTranslator(emit);
    let finished = false;
    await failWithReport(translator, () => runCliProcess({
      label: "Claude Code",
      command: cliCommand("claude-code"),
      args: buildClaudeArgs({ ...options, resumeId }),
      cwd: options.cwd,
      // The local login may live in ANTHROPIC_* (a gateway); everything else secret stays out.
      env: claudeEnv(scrubSecretEnv(process.env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]), options.provider),
      signal: options.signal,
      stdinLines: [
        {
          type: "control_request",
          request_id: "raytonebot_init",
          request: { subtype: "initialize", hooks: {}, sdkMcpServers: [], supportedDialogKinds: [] },
        },
        { type: "user", message: { role: "user", content: options.prompt }, parent_tool_use_id: null },
      ],
      onLine(line, stdin) {
        const type = line.type;
        if (type === "control_request") {
          void answerClaudeControl(line, stdin, translator, options);
          return;
        }
        if (type === "control_response" || type === "keep_alive" || type === "control_cancel_request") return;
        translator.push(line);
        if (type === "result") finished = true;
        if (translator.sessionId) options.onSessionId(translator.sessionId);
      },
      isFinished: () => finished,
    }));
  };
  try {
    await attempt(options.resumeId);
  } catch (error) {
    // A session Claude no longer has (deleted, other machine) gets one cold retry, but only
    // before anything reached the transcript.
    if (options.resumeId && emitted === 0 && isMissingSession(String(error))) await attempt(undefined);
    else throw error;
  }
}

async function answerClaudeControl(
  line: JsonLine,
  stdin: NodeJS.WritableStream,
  translator: ReturnType<typeof createClaudeStreamTranslator>,
  options: ClaudeRunOptions,
) {
  const requestId = typeof line.request_id === "string" ? line.request_id : undefined;
  const request = line.request && typeof line.request === "object" ? line.request as Record<string, unknown> : undefined;
  if (!requestId || !request) return;
  if (request.subtype !== "can_use_tool") {
    writeLine(stdin, {
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: `Unsupported control request: ${String(request.subtype)}` },
    });
    return;
  }
  const toolName = typeof request.tool_name === "string" ? request.tool_name : "tool";
  const input = request.input && typeof request.input === "object" ? request.input as Record<string, unknown> : {};
  const toolUseID = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const toolCallId = toolUseID ?? `claude_permission_${requestId}`;
  let decision: true | string;
  try {
    decision = await options.onPermission({
      toolCallId,
      tool: normalizeClaudeTool(toolName, input),
      startExecution: () => translator.startExecution(toolCallId, normalizeClaudeTool(toolName, input)),
    });
  } catch (error) {
    decision = error instanceof Error ? error.message : "Tool execution was denied.";
  }
  controlResponse(stdin, requestId, decision === true
    ? { behavior: "allow", updatedInput: input, ...(toolUseID ? { toolUseID } : {}) }
    : { behavior: "deny", message: decision, ...(toolUseID ? { toolUseID } : {}) });
}

/** One Codex CLI turn. Codex has no per-step approval in `exec`; the sandbox is the boundary. */
export async function runCodex(options: CodexRunOptions): Promise<void> {
  let emitted = 0;
  const emit = (event: PiWireEvent) => {
    emitted += 1;
    options.emit(event);
  };
  const attempt = async (resumeId: string | undefined) => {
    const translator = createCodexStreamTranslator(emit);
    await failWithReport(translator, () => runCliProcess({
      label: "Codex CLI",
      command: cliCommand("codex"),
      args: buildCodexArgs({ ...options, resumeId }),
      cwd: options.cwd,
      env: options.provider
        ? { ...scrubSecretEnv(process.env), [CODEX_PROVIDER_KEY_ENV]: options.provider.apiKey }
        : scrubSecretEnv(process.env, ["OPENAI_API_KEY", "CODEX_API_KEY"]),
      signal: options.signal,
      stdinText: options.prompt,
      onLine(line) {
        translator.push(line);
        if (translator.sessionId) options.onSessionId(translator.sessionId);
      },
    }), codexHint);
  };
  try {
    await attempt(options.resumeId);
  } catch (error) {
    if (options.resumeId && emitted === 0 && isMissingSession(String(error))) await attempt(undefined);
    else throw error;
  }
}
