import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { buildClaudeArgs, buildCodexArgs, claudeEnv, runClaudeCode, runCodex } from "./cliHarness.ts";
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

  const codex = buildCodexArgs({ cwd: "/w", resumeId: "th" });
  assert.deepEqual(codex.slice(0, 2), ["app-server", "--stdio"]);
  assert.ok(codex.includes('projects."/w".trust_level="untrusted"'));
  assert.ok(!codex.includes("--ignore-user-config"), "app-server does not support exec flags");

  const local = claudeEnv({ ANTHROPIC_AUTH_TOKEN: "host", CLAUDECODE: "1", CLAUDE_CODE_TASK_LIST_ID: "parent-tasks", PATH: "/bin" }, undefined);
  assert.equal(local.ANTHROPIC_AUTH_TOKEN, "host", "the local login is the host's own auth");
  assert.equal(local.CLAUDECODE, undefined, "a product run is not a nested session");
  assert.equal(local.CLAUDE_CODE_TASK_LIST_ID, undefined, "task lists belong to the product session");
  assert.equal(local.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
  assert.equal(local.CLAUDE_CODE_ENABLE_TASKS, "1");
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
  const args = buildCodexArgs({ cwd: "/w", provider: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-flash" } });
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
    GITHUB_TOKEN: "gh",
    NPM_TOKEN: "npm",
    SLACK_BOT_TOKEN: "slack",
    AWS_SECRET_ACCESS_KEY: "aws",
    RAYTONEBOT_PUBLIC_ORIGIN: "https://x",
  }, ["OPENAI_API_KEY"]);
  assert.deepEqual(env, { PATH: "/bin", OPENAI_API_KEY: "o", RAYTONEBOT_PUBLIC_ORIGIN: "https://x" });
  const codex = buildCodexArgs({ cwd: "/w" });
  assert.match(codex.join(" "), /shell_environment_policy\.include_only=\["PATH"/);
});

test("CLI output limit stops an unterminated stdout line before readline can grow indefinitely", async () => {
  const dir = mkdtempSync("/tmp/raytone-cli-output-test-");
  const previous = process.env.RAYTONEBOT_CODEX_BIN;
  const previousHome = process.env.HOME;
  const previousLimit = process.env.RAYTONEBOT_RUN_OUTPUT_BYTES;
  const executable = `${dir}/fake-codex`;
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000);\n`);
  chmodSync(executable, 0o700);
  process.env.RAYTONEBOT_CODEX_BIN = executable;
  process.env.HOME = dir;
  process.env.RAYTONEBOT_RUN_OUTPUT_BYTES = "65536";
  try {
    await assert.rejects(runCodex({ cwd: dir, prompt: "unused", permissionMode: "request", signal: AbortSignal.timeout(5000),
      emit() {}, onSessionId() {}, onPermission: async () => true }), /65536 byte turn output limit/);
  } finally {
    if (previous === undefined) delete process.env.RAYTONEBOT_CODEX_BIN;
    else process.env.RAYTONEBOT_CODEX_BIN = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousLimit === undefined) delete process.env.RAYTONEBOT_RUN_OUTPUT_BYTES;
    else process.env.RAYTONEBOT_RUN_OUTPUT_BYTES = previousLimit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing native history never silently retries the prompt in a fresh CLI session", async () => {
  const dir = mkdtempSync("/tmp/raytone-missing-session-");
  const executable = `${dir}/fake-cli`, calls = `${dir}/calls`;
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const log = (value) => fs.appendFileSync(${JSON.stringify(calls)}, value + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (!process.argv.includes('app-server')) {
  const resume = process.argv.includes('--resume'); log(resume ? 'resume' : 'fresh');
  if (resume) { send({type:'result',subtype:'error',is_error:true,errors:['No conversation found with session ID: missing']}); process.exit(0); }
  send({type:'result',subtype:'success',is_error:false,session_id:'replacement'}); process.exit(0);
}
require('node:readline').createInterface({input:process.stdin}).on('line', raw => {
 const m = JSON.parse(raw);
 if(m.method === 'initialize') send({id:m.id,result:{}});
 if(m.method === 'thread/resume') { log('resume'); send({id:m.id,error:{message:'no rollout found for thread id missing'}}); }
 if(m.method === 'thread/start') { log('fresh'); send({id:m.id,result:{thread:{id:'replacement'}}}); }
 if(m.method === 'turn/start') send({method:'turn/completed',params:{threadId:'replacement',turn:{id:'t',status:'completed'}}});
});
`);
  chmodSync(executable, 0o700);
  const previousClaude = process.env.RAYTONEBOT_CLAUDE_BIN, previousCodex = process.env.RAYTONEBOT_CODEX_BIN;
  process.env.RAYTONEBOT_CLAUDE_BIN = process.env.RAYTONEBOT_CODEX_BIN = executable;
  try {
    for (const run of [runClaudeCode, runCodex]) {
      writeFileSync(calls, "");
      const sessions: string[] = [];
      await assert.rejects(run({ cwd: dir, prompt: "A follow-up that depends on saved context", resumeId: "missing",
        permissionMode: "request", signal: AbortSignal.timeout(5000), emit() {}, onSessionId(id) { sessions.push(id); },
        onPermission: async () => true }), /Restore.*native session.*start a new conversation/);
      assert.equal(readFileSync(calls, "utf8"), "resume\n");
      assert.deepEqual(sessions, [], "the saved binding must not be replaced");
    }
    writeFileSync(executable, "#!/usr/bin/env node\nprocess.stderr.write('No conversation found with session ID: missing'); process.exit(1);\n");
    await assert.rejects(runClaudeCode({ cwd: dir, prompt: "Keep the CLI's actual failure cause", resumeId: "missing",
      permissionMode: "request", signal: AbortSignal.timeout(5000), emit() {}, onSessionId() {},
      onPermission: async () => true }), /Restore.*native session.*start a new conversation/);
  } finally {
    if (previousClaude === undefined) delete process.env.RAYTONEBOT_CLAUDE_BIN; else process.env.RAYTONEBOT_CLAUDE_BIN = previousClaude;
    if (previousCodex === undefined) delete process.env.RAYTONEBOT_CODEX_BIN; else process.env.RAYTONEBOT_CODEX_BIN = previousCodex;
    rmSync(dir, { recursive: true, force: true });
  }
});
