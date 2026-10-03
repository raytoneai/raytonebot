import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildClaudeArgs, buildCodexArgs, claudeEnv } from "./cliHarness.ts";
import {
  createClaudeStreamTranslator,
  createCodexStreamTranslator,
  displayCommand,
  normalizeClaudeTool,
} from "./cliStreams.ts";

type Wire = Record<string, unknown>;

function fixture(name: string): Wire[] {
  return readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Wire);
}

function updates(events: Wire[], type: string) {
  return events
    .filter((event) => event.type === "message_update")
    .map((event) => event.assistantMessageEvent as Wire)
    .filter((update) => update.type === type);
}

test("Claude Code stream: tool call, result and streamed reply (captured from 2.1.287)", () => {
  const events: Wire[] = [];
  const translator = createClaudeStreamTranslator((event) => events.push(event));
  for (const line of fixture("claude-stream.jsonl")) translator.push(line);

  assert.equal(translator.sessionId, "c628abf7-9fa1-4e77-95d3-19eac1e6a95e");
  assert.equal(translator.failure, undefined);
  const [start] = updates(events, "toolcall_start");
  assert.equal(start.toolName, "bash");
  const [end] = updates(events, "toolcall_end");
  assert.equal((end.toolCall as Wire).name, "bash");
  assert.equal(((end.toolCall as Wire).arguments as Wire).command, "ls");

  const execution = events.filter((event) => event.type === "tool_execution_start");
  const finished = events.filter((event) => event.type === "tool_execution_end");
  assert.equal(execution.length, 1, "a call without a permission prompt starts at its result");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].isError, false);
  assert.match(JSON.stringify(finished[0].result), /a\.txt/);

  assert.equal(updates(events, "text_delta").map((update) => update.delta).join(""), "done");
  // Two streamed assistant messages; the duplicate whole-message lines add none.
  assert.equal(events.filter((event) => event.type === "message_start").length, 2);
  assert.equal(events.filter((event) => event.type === "message_end").length, 2);
});

test("Claude Code: unstreamed assistant message, subagent noise, failure", () => {
  const events: Wire[] = [];
  const translator = createClaudeStreamTranslator((event) => events.push(event));
  translator.push({
    type: "assistant",
    message: { id: "m1", content: [{ type: "text", text: "plan" }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.md", content: "x" } }] },
  });
  translator.push({ type: "assistant", parent_tool_use_id: "task1", message: { id: "sub", content: [{ type: "text", text: "noise" }] } });
  assert.equal(updates(events, "text_delta").map((update) => update.delta).join(""), "plan");
  assert.deepEqual((updates(events, "toolcall_end")[0].toolCall as Wire).arguments, { content: "x", path: "a.md" });

  assert.equal(translator.startExecution("t1"), true);
  assert.equal(translator.startExecution("t1"), false);
  translator.startExecution("unknown", { name: "bash", args: { command: "pwd" } });
  assert.equal(events.at(-1)?.toolName, "bash");

  translator.push({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["max turns"] });
  assert.equal(translator.failure, "max turns");
});

test("Codex exec stream (captured from 0.153.4)", () => {
  const events: Wire[] = [];
  const translator = createCodexStreamTranslator((event) => events.push(event));
  for (const line of fixture("codex-exec.jsonl")) translator.push(line);

  assert.equal(translator.sessionId, "01a1003a-4e6d-7da0-b3b9-ad63a53120cb");
  assert.equal(translator.failure, undefined);
  assert.equal(events[0].type, "agent_start");
  const start = events.find((event) => event.type === "tool_execution_start");
  assert.equal(start?.toolName, "bash");
  assert.deepEqual(start?.args, { command: "ls" });
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.isError, false);
  assert.equal(updates(events, "text_delta").map((update) => update.delta).join("|"), "I’ll run `ls`.\n|done");
});

test("Codex: retry notices do not fail a turn; turn.failed does", () => {
  const translator = createCodexStreamTranslator(() => {});
  translator.push({ type: "error", message: "Reconnecting... 1/5" });
  translator.push({ type: "turn.completed" });
  assert.equal(translator.failure, undefined);
  translator.push({ type: "turn.failed", error: {} });
  assert.equal(translator.failure, "Reconnecting... 1/5");
});

test("command display and Claude tool names", () => {
  assert.equal(displayCommand("/bin/zsh -lc ls"), "ls");
  assert.equal(displayCommand("/bin/bash -lc 'npm test'"), "npm test");
  assert.equal(displayCommand("git status"), "git status");
  assert.deepEqual(normalizeClaudeTool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }), {
    name: "edit",
    args: { path: "a.ts", oldText: "a", newText: "b" },
  });
  assert.deepEqual(normalizeClaudeTool("WebFetch", { url: "u" }), { name: "WebFetch", args: { url: "u" } });
});

test("CLI launch arguments and environment", () => {
  const claude = buildClaudeArgs({ permissionMode: "request", resumeId: "s1", disallowedTools: ["Edit"] });
  for (const flag of ["--permission-prompt-tool", "--safe-mode", "--strict-mcp-config", "--include-partial-messages"]) {
    assert.ok(claude.includes(flag), flag);
  }
  assert.deepEqual(claude.slice(-2), ["--resume", "s1"]);
  assert.equal(claude.includes("--setting-sources"), false, "the local login keeps the host's own settings");
  const onProvider = buildClaudeArgs({ permissionMode: "request", provider: { baseUrl: "b", apiKey: "k", model: "m" } });
  assert.equal(onProvider[onProvider.indexOf("--setting-sources") + 1], "", "a provider run ignores settings env blocks");
  const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]);
  assert.ok(settings.permissions.ask.includes("Bash"), "read-only shell commands must still ask");

  const codex = buildCodexArgs({ cwd: "/w", sandbox: "read-only", resumeId: "th" });
  assert.deepEqual(codex.slice(-3), ["resume", "th", "-"]);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");

  const local = claudeEnv({ ANTHROPIC_AUTH_TOKEN: "host", CLAUDECODE: "1", PATH: "/bin" }, undefined);
  assert.equal(local.ANTHROPIC_AUTH_TOKEN, "host", "the local login is the host's own auth");
  assert.equal(local.CLAUDECODE, undefined, "a product run is not a nested session");
  assert.equal(local.PATH, "/bin");
  const provider = claudeEnv(
    { ANTHROPIC_API_KEY: "leak" },
    { baseUrl: "https://api.deepseek.com/anthropic", apiKey: "k", model: "deepseek-flash" },
  );
  assert.equal(provider.ANTHROPIC_API_KEY, undefined, "an inherited key must not override the provider");
  assert.equal(provider.ANTHROPIC_AUTH_TOKEN, "k");
  assert.equal(provider.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash");
});

test("Codex on a Responses-API provider: config flags, key only in Codex's env", () => {
  const args = buildCodexArgs({ cwd: "/w", sandbox: "workspace-write", provider: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-flash" } });
  const config = args.filter((_, index) => args[index - 1] === "-c");
  assert.ok(config.includes('model_provider="raytonebot"'));
  assert.ok(config.includes('model_providers.raytonebot.wire_api="responses"'));
  assert.ok(config.includes('model_providers.raytonebot.base_url="https://api.deepseek.com/v1"'));
  assert.ok(config.includes('model="deepseek-flash"'));
  assert.equal(args.includes("k"), false, "the key never appears in argv");
});

test("agent processes never inherit the bot's secrets", async () => {
  const { scrubSecretEnv } = await import("./runtime/childEnv.ts");
  const env = scrubSecretEnv({
    PATH: "/bin",
    RAYTONEBOT_PASSWORD: "p",
    E2B_API_KEY: "e",
    DEEPSEEK_API_KEY: "d",
    OPENAI_API_KEY: "o",
    GITHUB_TOKEN_SECRET: "g",
    RAYTONEBOT_PUBLIC_ORIGIN: "https://x",
  }, ["OPENAI_API_KEY"]);
  assert.deepEqual(env, { PATH: "/bin", OPENAI_API_KEY: "o", RAYTONEBOT_PUBLIC_ORIGIN: "https://x" });
  const codex = buildCodexArgs({ cwd: "/w", sandbox: "workspace-write" });
  assert.match(codex.join(" "), /shell_environment_policy\.include_only=\["PATH"/);
});
