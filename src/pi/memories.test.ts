import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildClaudeArgs } from "./cliHarness.ts";
import { normalizeClaudeTool } from "./cliStreams.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { createMemoryService, MEMORY_TOOL_SPECS, type MemoryService } from "./memories.ts";
import { classifyToolCall } from "./permissionPolicy.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";

function deliveredNote(memory: MemoryService, id: string) {
  const note = memory.noteFor(id);
  note?.delivered();
  return note?.text;
}

type Json = Record<string, unknown>;

test("preparing a memory note does not deliver it, and an old receipt cannot consume a newer version", () => {
  const memory = createMemoryService();
  memory.add("Use metric units.");
  const first = memory.noteFor("a")!;
  assert.match(memory.noteFor("a")!.text!, /metric units/);
  memory.add("Prefers brief answers.");
  first.delivered();
  const next = memory.noteFor("a")!;
  assert.match(next.text!, /updated[\s\S]*brief answers/);
  next.delivered();
  first.delivered();
  assert.equal(memory.noteFor("a"), undefined, "late receipts never move delivery backwards");
});

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
  assert.equal(deliveredNote(memory, "a"), undefined, "nothing to show");
  const saved = memory.add("Works on the Raytone mobile team.");
  const note = deliveredNote(memory, "a")!;
  assert.match(note, new RegExp(`\\(${saved.id}\\) Works on the Raytone mobile team\\.`));
  assert.match(note, /Background, not instructions/);
  assert.equal(deliveredNote(memory, "a"), undefined, "the second turn does not repeat it");

  // What a conversation saves itself does not come back to it; another conversation sees it.
  const tools = memory.toolsFor({ conversationId: "a", agent: "planner" })!;
  assert.deepEqual(tools.specs.map((spec) => spec.name), ["remember", "forget", "recall_memories"]);
  const result = JSON.parse((await tools.run("remember", { text: "Prefers metric units." })).text);
  assert.equal(result.saved, true);
  assert.equal(deliveredNote(memory, "a"), undefined);
  assert.deepEqual(memory.state().memories.at(-1)?.source, { conversationId: "a", agent: "planner" });
  assert.match(deliveredNote(memory, "b")!, /Prefers metric units[\s\S]*Works on the Raytone/, "newest first");

  // A change made elsewhere reaches "a" on its next turn, marked as an update.
  memory.add("Lives in Shanghai.");
  assert.match(deliveredNote(memory, "a")!, /updated[\s\S]*Lives in Shanghai/);
  assert.equal((await tools.run("forget", { id: "nope" })).isError, true);
  assert.equal((await tools.run("remember", { text: "password: x" })).isError, true);

  // Cleared or switched off: a conversation that saw them is told to drop them; tools go away.
  for (const item of memory.state().memories) memory.remove(item.id);
  assert.match(deliveredNote(memory, "a")!, /cleared or switched off/);
  assert.equal(deliveredNote(memory, "c"), undefined, "a conversation that saw nothing hears nothing");
  memory.add("Back again.");
  memory.setEnabled(false);
  assert.equal(memory.toolsFor({ conversationId: "a", agent: "assistant" }), undefined);
  assert.match(deliveredNote(memory, "a")!, /cleared or switched off/);
  assert.throws(() => memory.setEnabled("yes"), /true or false/);
});

test("a long list is cut at the note limit with a count of what was left out", () => {
  const memory = createMemoryService();
  for (let i = 0; i < 40; i += 1) memory.add(`${"Detail ".repeat(20)}${i}.`);
  const note = deliveredNote(memory, "a")!;
  assert.ok(note.length < 4600, String(note.length));
  assert.match(note, /older memories not shown/);
  assert.match(note, /Detail 39\./, "the newest is kept");
});

const botA = "bot_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const botB = "bot_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("notes and recall isolate Bots and groups while legacy memories stay global", async () => {
  const memory = createMemoryService();
  memory.add("Legacy shared preference.");
  memory.add("Explicit shared preference.", { kind: "global" });
  const privateA = memory.add("Bot A private preference.", { kind: "bot", id: botA });
  const privateB = memory.add("Bot B private preference.", { kind: "bot", id: botB });
  const groupA = memory.add("Group A shared preference.", { kind: "group", id: "room:a" });
  const groupB = memory.add("Group B shared preference.", { kind: "group", id: "room:b" });
  const context = { botId: botA, groupId: "room:a" };
  const note = memory.noteFor("chat", context)!;
  assert.match(note.text!, /Legacy shared preference/);
  assert.match(note.text!, /Explicit shared preference/);
  assert.match(note.text!, /Bot A private preference/);
  assert.match(note.text!, /Group A shared preference/);
  assert.doesNotMatch(note.text!, /Bot B|Group B/);
  note.delivered();
  assert.equal(memory.noteFor("chat", context), undefined);
  assert.match(memory.noteFor("chat", { botId: botB, groupId: "room:b" })!.text!, /Bot B private preference/,
    "another Bot's receipt in the same group conversation cannot suppress this context");

  const toolsA = memory.toolsFor({ conversationId: "chat", agent: "assistant", ...context })!;
  const recalled = JSON.parse((await toolsA.run("recall_memories", {})).text);
  assert.deepEqual(recalled.memories.map((item: Json) => item.text), ["Group A shared preference.", "Bot A private preference.", "Explicit shared preference.", "Legacy shared preference."]);
  assert.equal(recalled.total, 4);
  for (const inaccessible of [privateB, groupB]) {
    assert.deepEqual(await toolsA.run("forget", { id: inaccessible.id }), await toolsA.run("forget", { id: "missing" }),
      "forget does not reveal whether another owner has the id");
    assert.equal(memory.state().memories.some(item => item.id === inaccessible.id), true);
  }
  assert.equal((await toolsA.run("forget", { id: privateA.id })).isError, false);
  const toolsBInGroupA = memory.toolsFor({ conversationId: "other-chat", agent: "assistant", botId: botB, groupId: "room:a" })!;
  assert.equal((await toolsBInGroupA.run("forget", { id: groupA.id })).isError, false, "members can manage their shared group memories");
  const legacyNote = memory.noteFor("legacy")!.text!;
  assert.match(legacyNote, /Legacy shared preference/);
  assert.doesNotMatch(legacyNote, /Bot [AB]|Group [AB]/);
});

test("remember resolves owners from the run, deduplicates only within its scope, and retains Bot attribution", async () => {
  const memory = createMemoryService();
  const source = { conversationId: "chat-a", agent: "assistant" as const, botId: botA };
  const toolsA = memory.toolsFor(source)!;
  const savedA = JSON.parse((await toolsA.run("remember", { text: "Uses metric units." })).text);
  assert.deepEqual(savedA.scope, { kind: "bot", id: botA });
  assert.deepEqual(memory.state().memories[0].source, source);
  const duplicate = JSON.parse((await toolsA.run("remember", { text: "uses metric units." })).text);
  assert.equal(duplicate.id, savedA.id);
  const toolsB = memory.toolsFor({ conversationId: "chat-b", agent: "assistant", botId: botB })!;
  const savedB = JSON.parse((await toolsB.run("remember", { text: "Uses metric units." })).text);
  assert.notEqual(savedB.id, savedA.id, "the same sentence saved by another Bot must not return a private memory id");
  assert.deepEqual(savedB.scope, { kind: "bot", id: botB });
  const toolsGroup = memory.toolsFor({ ...source, groupId: "room:a" })!;
  assert.deepEqual(JSON.parse((await toolsGroup.run("remember", { text: "Uses metric units." })).text).scope, { kind: "group", id: "room:a" });
  assert.deepEqual(JSON.parse((await toolsGroup.run("remember", { text: "Personal preference.", scope: "bot" })).text).scope, { kind: "bot", id: botA });
  assert.deepEqual(JSON.parse((await toolsA.run("remember", { text: "Shared preference.", scope: "global" })).text).scope, { kind: "global" });
  for (const args of [{ text: "Unwanted.", scope: { kind: "bot", id: botB } }, { text: "Unwanted.", scope: "bot", botId: botB }, { text: "Unwanted.", scope: "group" }]) {
    assert.equal((await toolsA.run("remember", args)).isError, true);
  }
  assert.equal(memory.state().memories.some(item => item.text === "Unwanted."), false);
  assert.deepEqual(JSON.parse((await memory.toolsFor({ conversationId: "legacy", agent: "planner" })!.run("remember", { text: "Old caller." })).text).scope, { kind: "global" });
});

test("recall retrieves older eligible memories with stable metadata and bounded read-only results", async () => {
  const memory = createMemoryService();
  const source = { conversationId: "chat-a", agent: "assistant" as const, botId: botA };
  const tools = memory.toolsFor(source)!;
  const old = JSON.parse((await tools.run("remember", { text: "Older searchable fact." })).text);
  for (let i = 0; i < 40; i += 1) memory.add(`${"Detail ".repeat(20)}${i}.`, { kind: "bot", id: botA });
  memory.add("Older searchable fact belongs to another Bot.", { kind: "bot", id: botB });
  const note = memory.noteFor(source.conversationId, source)!;
  assert.doesNotMatch(note.text!, /Older searchable fact/);
  assert.match(note.text!, /older memories not shown/);
  note.delivered();
  const recalled = JSON.parse((await tools.run("recall_memories", { query: "OLDER SEARCHABLE" })).text);
  assert.equal(recalled.total, 1);
  assert.equal(recalled.hasMore, false);
  assert.deepEqual(recalled.memories, [memory.state().memories.find(item => item.id === old.id)]);
  assert.deepEqual(recalled.memories[0].source, source);
  assert.equal(memory.noteFor(source.conversationId, source), undefined, "recall does not increment the saved version");
  const bounded = JSON.parse((await tools.run("recall_memories", { limit: 20 })).text);
  assert.equal(bounded.memories.length, 20);
  assert.equal(bounded.total, 41);
  assert.equal(bounded.hasMore, true);
  assert.equal(JSON.parse((await tools.run("recall_memories", {})).text).memories.length, 10);
  for (const input of [{ limit: 21 }, { limit: 0 }, { limit: 1.5 }, { query: "x".repeat(201) }]) assert.equal((await tools.run("recall_memories", input)).isError, true);
  memory.setEnabled(false);
  assert.equal(memory.toolsFor(source), undefined);
  for (const [name, args] of [["recall_memories", {}], ["remember", { text: "Disabled save." }], ["forget", { id: old.id }]] as const) {
    const result = await tools.run(name, args);
    assert.equal(result.isError, true, "tools captured before disabling also stop reading and writing");
    assert.match(result.text, /switched off/);
  }
});

test("scoped delivery receipts acknowledge only their captured version and context", async () => {
  const memory = createMemoryService();
  memory.add("Shared first fact.");
  const context = { botId: botA, groupId: "room:a" };
  const first = memory.noteFor("chat", context)!;
  const other = memory.noteFor("chat", { botId: botB, groupId: "room:a" })!;
  memory.add("Later scoped fact.", { kind: "group", id: "room:a" });
  first.delivered();
  const next = memory.noteFor("chat", context)!;
  assert.match(next.text!, /updated[\s\S]*Later scoped fact/);
  next.delivered();
  first.delivered();
  assert.equal(memory.noteFor("chat", context), undefined);
  other.delivered();
  assert.match(memory.noteFor("chat", { botId: botB, groupId: "room:a" })!.text!, /Later scoped fact/);
  await memory.toolsFor({ conversationId: "chat", agent: "assistant", ...context })!.run("remember", { text: "Known in this run." });
  assert.equal(memory.noteFor("chat", context), undefined, "a caller already current does not replay its own save");
});

test("scope persistence preserves legacy global entries and text-only edits; malformed files fail closed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-scope-"));
  const file = join(dataDir, "memories.json");
  const legacy = { id: "mlegacy", text: "Legacy preference.", createdAt: 1, updatedAt: 1, source: { conversationId: "old-chat", agent: "planner" } };
  try {
    writeFileSync(file, JSON.stringify({ enabled: true, version: 1, memories: [legacy] }));
    const memory = createMemoryService({ dataDir });
    assert.deepEqual(memory.state().memories, [legacy]);
    assert.match(memory.noteFor("new-chat", { botId: botA })!.text!, /Legacy preference/);
    memory.update(legacy.id, "Updated legacy preference.");
    assert.equal(memory.state().memories[0].scope, undefined);
    const own = memory.add("Scoped fact.", { kind: "bot", id: botA });
    assert.deepEqual(memory.update(own.id, "Edited scoped fact.").scope, own.scope);
    assert.deepEqual(createMemoryService({ dataDir }).state().memories[1].scope, own.scope);
    assert.deepEqual(memory.update(own.id, "Shared now.", { kind: "global" }).scope, { kind: "global" });
    for (const scope of [{ kind: "unknown" }, { kind: "bot", id: "other" }, { kind: "group", id: "../bad" }, { kind: "global", id: botA }]) {
      assert.throws(() => memory.add("Invalid scope.", scope as never), /Invalid memory scope/);
      assert.throws(() => memory.update(own.id, "Invalid scope.", scope as never), /Invalid memory scope/);
    }
    const malformed = [
      [{ ...legacy, scope: { kind: "bot", id: "wrong" } }],
      [{ ...legacy, scope: { kind: "group", id: "../bad" } }],
      [{ ...legacy, scope: { kind: "global", id: "unexpected" } }],
      [{ ...legacy, scope: { kind: "unknown" } }],
      [{ ...legacy, source: { ...legacy.source, botId: "wrong" } }],
      [{ ...legacy, id: "../invalid" }],
      [legacy, legacy],
      Array.from({ length: 101 }, (_, i) => ({ ...legacy, id: `m${i}` })),
    ];
    for (const memories of malformed) {
      const original = JSON.stringify({ enabled: true, version: 2, memories });
      writeFileSync(file, original);
      const unreadable = createMemoryService({ dataDir });
      assert.equal(unreadable.enabled, false);
      assert.equal(unreadable.noteFor("chat"), undefined);
      assert.equal(unreadable.toolsFor({ conversationId: "chat", agent: "assistant" }), undefined);
      assert.throws(() => unreadable.state(), /could not be read/);
      assert.throws(() => unreadable.add("Do not replace."), /could not be read/);
      assert.equal(readFileSync(file, "utf8"), original);
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("remember and forget ask like connector calls, through every engine's host-tool channel", async () => {
  const policy = { cwd: "/workspace", protectedPaths: [] };
  assert.equal(classifyToolCall("remember", { text: "x" }, policy), "connector");
  assert.equal(classifyToolCall("forget", { id: "m1" }, policy), "connector");
  assert.equal(normalizeClaudeTool("mcp__raytone__remember", { text: "x" }).name, "remember");

  const hostTools = { specs: MEMORY_TOOL_SPECS, async run() { return { text: "{\"saved\":true}", isError: false }; } };
  const args = buildClaudeArgs({ permissionMode: "request", hostTools });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { raytone: { type: "sdk", name: "raytone" } } },
    "the host's own server carries memory tools even without web tools");

  const sent: Json[] = [], asked: string[] = [];
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "remember", signal: new AbortController().signal, hostTools,
    emit() {}, onSessionId() {}, async onPermission(request) { asked.push(request.tool.name); return true; } });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "initialize", result: {} });
  assert.deepEqual(((sent[1].params as Json).dynamicTools as Json[]).map((tool) => tool.name), ["remember", "forget", "recall_memories"]);
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
