import { homedir } from "node:os";

import type { AgentHarnessId } from "./harnessCatalog.ts";
import type { ClaudeRunOptions, CodexRunOptions } from "./cliHarness.ts";

/**
 * CLI launch configuration for Claude Code and Codex CLI.
 *
 * Launch flags and the Claude stdio permission protocol follow TelegramAgent's runtime
 * adapters (`backend/src/claudeCodeRuntime.ts`, `codexCliRuntime.ts`); the Claude env
 * hardening list follows OpenAgentCore's `claude-sdk-adapter/src/workspace.ts` (MIT).
 */

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
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
];

/** Tools whose every call goes through RaytoneBot's approval gate. */
const CLAUDE_ASK_TOOLS = ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "AskUserQuestion"];

export function cliCommand(harness: Exclude<AgentHarnessId, "pi">, env: NodeJS.ProcessEnv = process.env): string {
  if (harness === "claude-code") return env.RAYTONEBOT_CLAUDE_BIN?.trim() || "claude";
  if (harness === "dsh") return env.RAYTONEBOT_DSH_BIN?.trim() || "dsh";
  return env.RAYTONEBOT_CODEX_BIN?.trim() || "codex";
}

/** In-process MCP server for the host's web, memory, browser, and other tools. */
export const CLAUDE_HOST_MCP = "raytone";

export function buildClaudeArgs(options: Pick<ClaudeRunOptions, "permissionMode" | "resumeId" | "forkAtMessageId" | "provider" | "appendSystemPrompt" | "disallowedTools" | "addDirs" | "webTools" | "mcpTools" | "hostTools">): string[] {
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
  // Claude's WebSearch needs Anthropic's server and WebFetch the agent's own (blocked) egress.
  const disallowed = [...options.disallowedTools ?? [], ...options.webTools ? ["WebSearch", "WebFetch"] : []];
  const sdkServers = claudeSdkServers(options);
  if (sdkServers.length) args.push("--mcp-config", JSON.stringify({ mcpServers: Object.fromEntries(sdkServers.map((name) => [name, { type: "sdk", name }])) }));
  if (disallowed.length) args.push("--disallowedTools", ...disallowed);
  if (options.addDirs?.length) args.push("--add-dir", ...options.addDirs);
  if (options.resumeId) args.push("--resume", options.resumeId);
  if (options.forkAtMessageId) args.push("--fork-session", "--resume-session-at", options.forkAtMessageId);
  return args;
}

/** Control-channel MCP servers: the host's tools first, then the user's servers. */
export function claudeSdkServers(options: Pick<ClaudeRunOptions, "webTools" | "mcpTools" | "hostTools">): string[] {
  return [...options.webTools || options.hostTools ? [CLAUDE_HOST_MCP] : [], ...options.mcpTools?.servers.map((server) => server.id) ?? []];
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
  "CLAUDE_CODE_TASK_LIST_ID",
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
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "1",
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

export function buildCodexArgs(options: Pick<CodexRunOptions, "cwd" | "resumeId" | "addDirs" | "provider">, home = homedir()): string[] {
  const args = [
    "app-server", "--stdio",
    // HOME/CODEX_HOME are private per run. Explicitly distrust project config as well.
    "-c", `projects.${JSON.stringify(options.cwd)}.trust_level="untrusted"`,
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "shell_snapshot",
    "--disable", "multi_agent",
    // Commands Codex runs see only basic variables, never the key Codex itself uses.
    "-c", `shell_environment_policy.inherit="all"`,
    "-c", `shell_environment_policy.include_only=${JSON.stringify(CODEX_COMMAND_ENV)}`,
    "-c", `shell_environment_policy.set.HOME=${JSON.stringify(home)}`,
  ];
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
  return args;
}
