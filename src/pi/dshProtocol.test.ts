import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDshProtocol, normalizeDshTool } from "./dshProtocol.ts";
import { dshPatch, isolatedDshHome, runDsh } from "./dshHarness.ts";
import { BotConfigStore } from "./botConfig.ts";
import { DEFAULT_NEW_BOT } from "../runtime/botAppearance.ts";

function fixture(overrides: Partial<Parameters<typeof createDshProtocol>[0]> = {}) {
  const sent: any[] = [], events: any[] = [], permissions: any[] = [];
  const abort = new AbortController();
  const protocol = createDshProtocol({ cwd: "/workspace", prompt: "Hello", signal: abort.signal,
    emit: event => events.push(event), onSessionId() {},
    onPermission: async request => { permissions.push(request); request.startExecution(); return true; }, ...overrides });
  const push = (line: any) => protocol.push(line, message => sent.push(message));
  const update = (value: any, sessionId = "session-1") => push({ method: "session/update", params: { sessionId, update: value } });
  const permission = (id: string, sessionId = "session-1", requestId = id) => push({ id: requestId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: id } } });
  push({ id: "initialize", result: { protocolVersion: 1 } });
  push({ id: "session", result: { sessionId: "session-1" } });
  return { protocol, push, update, permission, sent, events, permissions, abort };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("isolated DSH requires explicit deployment opt-in", async () => {
  const previous = { sandbox: process.env.RAYTONEBOT_SANDBOX, optIn: process.env.RAYTONEBOT_DSH_ISOLATED,
    binary: process.env.RAYTONEBOT_DSH_BIN };
  try {
    process.env.RAYTONEBOT_SANDBOX = "1";
    process.env.RAYTONEBOT_DSH_BIN = "/nonexistent/raytone-dsh-test";
    const options = { signal: new AbortController().signal } as Parameters<typeof runDsh>[0];
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.RAYTONEBOT_DSH_ISOLATED;
      else process.env.RAYTONEBOT_DSH_ISOLATED = value;
      await assert.rejects(runDsh(options), /RAYTONEBOT_DSH_ISOLATED=1/);
    }
    process.env.RAYTONEBOT_DSH_ISOLATED = "1";
    await assert.rejects(runDsh(options), /DeepSeek Harness is not installed/);
    delete process.env.RAYTONEBOT_SANDBOX;
    delete process.env.RAYTONEBOT_DSH_ISOLATED;
    await assert.rejects(runDsh(options), /DeepSeek Harness is not installed/);
  } finally {
    for (const [key, value] of Object.entries({ RAYTONEBOT_SANDBOX: previous.sandbox,
      RAYTONEBOT_DSH_ISOLATED: previous.optIn, RAYTONEBOT_DSH_BIN: previous.binary })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("DSH accepts compaction notifications only for its active native session, including close flush", () => {
  const f = fixture();
  f.events.length = 0;
  assert.equal(f.protocol.contextCompacted(undefined), false);
  assert.equal(f.protocol.contextCompacted("other"), false);
  assert.deepEqual(f.events, []);
  assert.equal(f.protocol.contextCompacted("session-1"), true);
  f.push({ id: "prompt", error: { message: "Model failed after compaction" } });
  assert.equal(f.protocol.contextCompacted("session-1"), true, "the session flush completes before close returns");
  assert.deepEqual(f.events, [{ type: "context_compacted" }, { type: "context_compacted" }]);
  f.push({ id: "close", result: {} });
  assert.equal(f.protocol.contextCompacted("session-1"), false);
});

test("DSH bridge forwards successful compaction and flush waits for the host receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-compact-"));
  const socketPath = join(dir, "host.sock");
  const hooks = new Map<string, (...args: any[]) => any>();
  let receive!: (value: any) => void, acknowledge!: () => void;
  const received = new Promise<any>(resolve => { receive = resolve; });
  const server = createServer(socket => socket.once("data", data => {
    receive(JSON.parse(String(data)));
    acknowledge = () => socket.end(JSON.stringify({ text: "", isError: false }) + "\n");
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const pluginPath = "./runtime/dshPlugin.mjs";
    const { apply } = await import(pluginPath);
    await apply({ on: (name: string, hook: (...args: any[]) => any) => hooks.set(name, hook),
      tools: { guard() {} }, provide() {} }, { socketPath, tools: [] });
    assert.ok(hooks.has("session/event"));
    assert.ok(hooks.has("session/flush"));
    hooks.get("session/event")!({ id: "session-1" }, { type: "compaction/start", data: {} });
    hooks.get("session/event")!({ id: "session-1" }, { type: "unknown", data: {} });
    hooks.get("session/event")!({ id: "session-1" }, { type: "compaction/end", data: { error: "Failed" } });
    await hooks.get("session/flush")!();
    hooks.get("session/event")!({ id: "session-1" }, { type: "compaction/end", data: {} });
    assert.deepEqual(await received, { event: "context_compacted", sessionId: "session-1" });
    let flushed = false;
    const pending = hooks.get("session/flush")!().then(() => { flushed = true; });
    await flush();
    assert.equal(flushed, false);
    acknowledge(); await pending;
    assert.equal(flushed, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DSH normalizes real file and bash arguments before shared policy evaluation", () => {
  assert.deepEqual(normalizeDshTool("edit", { file_path: "a.txt", old_string: "a", new_string: "b" }, "/workspace"),
    { name: "edit", args: { file_path: "a.txt", old_string: "a", new_string: "b", path: "a.txt", oldText: "a", newText: "b" } });
  assert.equal(normalizeDshTool("write", {}, "/workspace"), undefined);
  assert.equal(normalizeDshTool("bash", { command: "sleep 10", run_in_background: true }, "/workspace"), undefined);
  assert.equal(normalizeDshTool("bash", { command: "pwd", workdir: "/elsewhere" }, "/workspace")?.args.cwd, "/elsewhere");
});

test("DSH denies unknown, malformed and cross-session approvals without invoking the gate", async () => {
  const f = fixture();
  f.permission("missing");
  f.update({ sessionUpdate: "tool_call", toolCallId: "bad", title: "write", rawInput: {} });
  f.permission("bad");
  f.update({ sessionUpdate: "tool_call", toolCallId: "valid", title: "write", rawInput: { file_path: "file", content: "hello" } });
  f.permission("valid", "other-session");
  await flush();
  assert.equal(f.permissions.length, 0);
  assert.deepEqual(f.sent.slice(-3).map(item => item.result.outcome.optionId), ["reject-once", "reject-once", "reject-once"]);
});

test("DSH awaits approval once and binds each host execution to its session, name and arguments", async () => {
  let resolve!: (value: true) => void;
  const f = fixture({ onPermission: request => { request.startExecution(); return new Promise(done => { resolve = done; }); } });
  const args = { path: "x", value: 2 };
  f.update({ sessionUpdate: "tool_call", toolCallId: "one", title: "host_probe", rawInput: args });
  f.permission("one");
  assert.equal(f.protocol.takeAuthorization("one", "host_probe", args, "session-1"), false);
  f.permission("one", "session-1", "duplicate");
  assert.equal(f.sent.at(-1).result.outcome.optionId, "reject-once");
  resolve(true); await flush();
  assert.equal(f.protocol.takeAuthorization("one", "host_probe", args, "other"), false);
  assert.equal(f.protocol.takeAuthorization("one", "other_tool", args, "session-1"), false);
  assert.equal(f.protocol.takeAuthorization("one", "host_probe", { ...args, value: 3 }, "session-1"), false);
  assert.equal(f.protocol.takeAuthorization("one", "host_probe", { value: 2, path: "x" }, "session-1"), true);
  assert.equal(f.protocol.takeAuthorization("one", "host_probe", args, "session-1"), false);
  assert.equal(f.events.filter(event => event.type === "tool_execution_start").length, 1);
});

test("DSH cancellation wins over a late approval and suppresses late assistant text", async () => {
  let resolve!: (value: true) => void;
  const f = fixture({ onPermission: () => new Promise(done => { resolve = done; }) });
  f.update({ sessionUpdate: "tool_call", toolCallId: "one", title: "write", rawInput: { file_path: "x", content: "no" } });
  f.permission("one");
  f.abort.abort(); f.protocol.cancel(message => f.sent.push(message));
  resolve(true); await flush();
  f.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
  assert.equal(f.sent.at(-1).result.outcome.outcome, "cancelled");
  assert.equal(f.events.some(event => event.type === "message_start"), false);
  assert.ok(f.sent.some(message => message.method === "session/cancel"));
  assert.equal(f.protocol.takeAuthorization("one", "write", { file_path: "x", content: "no" }, "session-1"), false);
});

test("DSH maps committed text, reasoning and failed tools exactly once", () => {
  const f = fixture();
  for (const sessionUpdate of ["agent_thought_chunk", "agent_message_chunk"]) f.update({ sessionUpdate, content: { type: "text", text: "answer" } });
  f.update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "read", rawInput: { file_path: "x" } });
  for (let i = 0; i < 2; i++) f.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed", content: [{ type: "content", content: { type: "text", text: "Missing file" } }] });
  assert.deepEqual(f.events.filter(event => event.type === "message_update" && event.assistantMessageEvent.delta).map(event => event.assistantMessageEvent.type), ["thinking_delta", "text_delta"]);
  assert.equal(f.events.filter(event => event.type === "tool_execution_end").length, 1);
  assert.equal(f.events.at(-1).isError, true);
  f.push({ id: "prompt", result: { stopReason: "max_tokens" } });
  assert.match(f.protocol.failure!, /max_tokens/);
  f.push({ id: "close", result: {} }); assert.equal(f.protocol.finished, true);
});

test("DSH never starts a fresh turn when the native resume fails or changes session", () => {
  const f = fixture({ resumeId: "expected-session" });
  assert.equal(f.sent[0].method, "session/resume");
  assert.match(f.protocol.failure!, /unexpected session/);
  assert.equal(f.sent.some(item => item.method === "session/prompt"), false);
});

test("DSH is an opt-in Bot and keeps the three built-in Bots unchanged", () => {
  const store = new BotConfigStore();
  assert.deepEqual(store.view().profiles.map(bot => bot.id), ["assistant", "planner", "builder"]);
  const botId = "bot_12345678-1234-1234-1234-123456789abc";
  store.save({ id: botId, name: "DeepSeek", presetId: "dsh", appearance: DEFAULT_NEW_BOT }, 0);
  const input = store.input({ prompt: "Hello", botId });
  assert.equal(input.agentPreset, "dsh");
  assert.equal(store.view().profiles.length, 4);
});

test("DSH controlled profile disables autonomous tools and session uploads, and persists outside personal DSH home", () => {
  const patch = dshPatch({ cwd: "/work", home: "/data/dsh/session", provider: { baseUrl: "http://127.0.0.1:1234", apiKey: "secret-not-in-patch", model: "deepseek-flash" } }, "/tmp/host.sock", []);
  for (const id of ["session-log-deepseek", "tool-subagent", "ptc-runtime", "credentials", "agent-instructions", "tool-jobs"]) {
    assert.ok(patch.some(item => "id" in item && item.id === id && "disabled" in item && item.disabled));
  }
  assert.equal(JSON.stringify(patch).includes("secret-not-in-patch"), false);
  assert.ok(JSON.stringify(patch).includes("/data/dsh/session/sessions"));
});


test("isolated DSH sessions are stable across deployment data paths and separated by conversation", () => {
  const a = isolatedDshHome("/data/one/dsh/session-1", "/home/raytone-agent");
  assert.equal(a, isolatedDshHome("/other/data/dsh/session-1", "/home/raytone-agent"));
  assert.notEqual(a, isolatedDshHome("/data/one/dsh/session-2", "/home/raytone-agent"));
  assert.match(a, /^\/home\/raytone-agent\/\.raytone-dsh\/[a-f0-9]{64}$/);
});

test("DSH shares only newly created workspace files in isolated mode", async () => {
  const { chmodSync, statSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-shared-"));
  const outside = mkdtempSync(join(tmpdir(), "rtb-dsh-outside-"));
  const hooks = new Map<string, (...args: any[]) => any>();
  const pluginPath = "./runtime/dshPlugin.mjs";
  const { apply } = await import(pluginPath);
  const create = join(dir, "created.txt"), existing = join(dir, "existing.txt"), external = join(outside, "other.txt");
  try {
    for (const file of [create, existing, external]) { writeFileSync(file, "data"); chmodSync(file, 0o600); }
    await apply({ on: (name: string, hook: (...args: any[]) => any) => hooks.set(name, hook),
      tools: { guard() {} }, provide() {} }, { socketPath: "", tools: [], sharedWorkspace: dir, sharedGid: process.getgid?.() });
    const run = hooks.get("tools/execute")!;
    for (const [path, operation] of [[create, "create"], [existing, "update"], [external, "create"]]) {
      await run({ name: "write" }, async () => ({ isError: false, value: { path, operation } }));
    }
    assert.equal(statSync(create).mode & 0o777, 0o660);
    assert.equal(statSync(existing).mode & 0o777, 0o600);
    assert.equal(statSync(external).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
