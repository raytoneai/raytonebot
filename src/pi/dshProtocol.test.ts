import test from "node:test";
import assert from "node:assert/strict";
import { createDshProtocol, normalizeDshTool } from "./dshProtocol.ts";
import { dshPatch } from "./dshHarness.ts";
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
