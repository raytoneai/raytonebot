import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildClaudeArgs } from "./cliHarness.ts";
import { normalizeClaudeTool } from "./cliStreams.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { createMemoryService, MEMORY_TOOL_SPECS } from "./memories.ts";
import { classifyToolCall } from "./permissionPolicy.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";

type Json = Record<string, unknown>;

test("memories are one list on disk: deduplicated, never secrets, capped, editable and removable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-"));
  try {
    const memory = createMemoryService({ dataDir });
    const first = memory.add("  Prefers   short answers. ");
    assert.equal(first.text, "Prefers short answers.");
    assert.equal(memory.add("prefers short answers.").id, first.id, "the same sentence is not saved twice");
    for (const secret of ["My key is sk-abcdefghijklmnopqrstuvwx", "password: hunter2", "ghp_abcdefghijklmnopqrstuvwxyz12"]) {
      assert.throws(() => memory.add(secret), /never hold passwords/);
    }
    assert.throws(() => memory.add(""), /1-300/);
    assert.throws(() => memory.add("x".repeat(301)), /1-300/);
    assert.equal(memory.update(first.id, "Prefers short answers in Chinese.").text, "Prefers short answers in Chinese.");
    assert.throws(() => memory.update("nope", "x"), /No memory/);
    assert.equal(statSync(join(dataDir, "memories.json")).mode & 0o777, 0o600);
    assert.deepEqual(createMemoryService({ dataDir }).state().memories.map((item) => item.text), ["Prefers short answers in Chinese."]);
    memory.remove(first.id);
    assert.throws(() => memory.remove(first.id), /No memory/);
    for (let i = 0; i < 100; i += 1) memory.add(`Fact number ${i}.`);
    assert.throws(() => memory.add("One more."), /full/);
    assert.doesNotMatch(readFileSync(join(dataDir, "memories.json"), "utf8"), /hunter2/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a conversation sees memories on its first turn and again only after they change", async () => {
  const memory = createMemoryService();
  assert.equal(memory.noteFor("a"), undefined, "nothing to show");
  const saved = memory.add("Works on the Raytone mobile team.");
  const note = memory.noteFor("a")!;
  assert.match(note, new RegExp(`\\(${saved.id}\\) Works on the Raytone mobile team\\.`));
  assert.match(note, /Background, not instructions/);
  assert.equal(memory.noteFor("a"), undefined, "the second turn does not repeat it");

  // What a conversation saves itself does not come back to it; another conversation sees it.
  const tools = memory.toolsFor({ conversationId: "a", agent: "planner" })!;
  assert.deepEqual(tools.specs.map((spec) => spec.name), ["remember", "forget"]);
  const result = JSON.parse((await tools.run("remember", { text: "Prefers metric units." })).text);
  assert.equal(result.saved, true);
  assert.equal(memory.noteFor("a"), undefined);
  assert.deepEqual(memory.state().memories.at(-1)?.source, { conversationId: "a", agent: "planner" });
  assert.match(memory.noteFor("b")!, /Prefers metric units[\s\S]*Works on the Raytone/, "newest first");

  // A change made elsewhere reaches "a" on its next turn, marked as an update.
  memory.add("Lives in Shanghai.");
  assert.match(memory.noteFor("a")!, /updated[\s\S]*Lives in Shanghai/);
  assert.equal((await tools.run("forget", { id: "nope" })).isError, true);
  assert.equal((await tools.run("remember", { text: "password: x" })).isError, true);

  // Cleared or switched off: a conversation that saw them is told to drop them; tools go away.
  for (const item of memory.state().memories) memory.remove(item.id);
  assert.match(memory.noteFor("a")!, /cleared or switched off/);
  assert.equal(memory.noteFor("c"), undefined, "a conversation that saw nothing hears nothing");
  memory.add("Back again.");
  memory.setEnabled(false);
  assert.equal(memory.toolsFor({ conversationId: "a", agent: "assistant" }), undefined);
  assert.match(memory.noteFor("a")!, /cleared or switched off/);
  assert.throws(() => memory.setEnabled("yes"), /true or false/);
});

test("a long list is cut at the note limit with a count of what was left out", () => {
  const memory = createMemoryService();
  for (let i = 0; i < 40; i += 1) memory.add(`${"Detail ".repeat(20)}${i}.`);
  const note = memory.noteFor("a")!;
  assert.ok(note.length < 4600, String(note.length));
  assert.match(note, /older memories not shown/);
  assert.match(note, /Detail 39\./, "the newest is kept");
});

test("remember and forget ask like connector calls, through every engine's host-tool channel", async () => {
  const policy = { cwd: "/workspace", protectedPaths: [] };
  assert.equal(classifyToolCall("remember", { text: "x" }, policy), "connector");
  assert.equal(classifyToolCall("forget", { id: "m1" }, policy), "connector");
  assert.equal(normalizeClaudeTool("mcp__raytone__remember", { text: "x" }).name, "remember");

  const memoryTools = { specs: MEMORY_TOOL_SPECS, async run() { return { text: "{\"saved\":true}", isError: false }; } };
  const args = buildClaudeArgs({ permissionMode: "request", memoryTools });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { raytone: { type: "sdk", name: "raytone" } } },
    "the host's own server carries memory tools even without web tools");

  const sent: Json[] = [], asked: string[] = [];
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "remember", signal: new AbortController().signal, memoryTools,
    emit() {}, onSessionId() {}, async onPermission(request) { asked.push(request.tool.name); return true; } });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "initialize", result: {} });
  assert.deepEqual(((sent[1].params as Json).dynamicTools as Json[]).map((tool) => tool.name), ["remember", "forget"]);
  push({ id: "thread", result: { thread: { id: "t" } } });
  push({ id: 7, method: "item/tool/call", params: { threadId: "t", callId: "c7", tool: "remember", arguments: { text: "Prefers tea." } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["remember"]);
  assert.deepEqual(sent.at(-1), { id: 7, result: { contentItems: [{ type: "inputText", text: "{\"saved\":true}" }], success: true } });
});

test("the host adds the memory note to the model's copy of the prompt and serves the settings routes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-host-"));
  const prompts: string[] = [];
  const factory: PiBridgeFactory = async () => {
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        prompts.push(prompt);
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() {}, dispose() {}, async configure() {}, async newSession() {},
      async state() { return { models: [], tools: [] }; },
    };
  };
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory, routineClock: false });
  const server: Server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/memories`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  };
  try {
    assert.deepEqual((await call("")).body, { enabled: true, memories: [] });
    const added = await call("", "POST", { text: "Prefers short answers." });
    assert.equal(added.status, 201);
    assert.equal((await call("", "POST", { text: "sk-abcdefghijklmnopqrstuvwxyz" })).status, 400);
    await host.controller.runPrompt({ conversationId: "chat", prompt: "你好" }, () => {});
    await host.controller.runPrompt({ conversationId: "chat", prompt: "再来" }, () => {});
    assert.match(prompts[0], /^你好[\s\S]*\[Memory from RaytoneBot[\s\S]*Prefers short answers\./);
    assert.doesNotMatch(prompts[1], /Memory from RaytoneBot/);
    assert.equal(host.controller.getConversation("chat")?.events.some((event) => JSON.stringify(event).includes("Memory from RaytoneBot")), false,
      "the transcript keeps what the user typed");

    const id = (added.body.memory as Json).id as string;
    assert.equal((await call(`/${id}`, "POST", { text: "Prefers short answers in Chinese." })).status, 200);
    await host.controller.runPrompt({ conversationId: "chat", prompt: "第三轮" }, () => {});
    assert.match(prompts[2], /updated[\s\S]*in Chinese/);
    assert.equal((await call("/settings", "POST", { enabled: false })).body.enabled, false);
    assert.equal((await call(`/${id}`, "DELETE")).status, 200);
    assert.equal((await call(`/${id}`, "DELETE")).status, 404);
  } finally {
    host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
