import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { DEFAULT_NEW_BOT } from "../runtime/botAppearance.ts";
import { BotConfigStore } from "./botConfig.ts";
import { createBotSkillsService } from "./botSkills.ts";
import { createConversationStore } from "./conversationStore.ts";
import { createMemoryService } from "./memories.ts";
import { createPiHttpHost, createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import type { PiRuntimeConfiguration } from "./piClient.ts";

const botA = "bot_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const botB = "bot_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const profile = (id: string, name: string) => ({ id, name, presetId: "assistant" as const, appearance: DEFAULT_NEW_BOT });
type BridgeInput = Parameters<PiBridgeFactory>[0];

function observingBridge(probe?: (input: BridgeInput, id: string, prompt: string) => Promise<void>) {
  const records: { id: string; prompt: string; role?: string; configuration?: PiRuntimeConfiguration; input: BridgeInput }[] = [];
  const failures: unknown[] = [];
  const factory: PiBridgeFactory = async input => {
    const id = decodeURIComponent(input.sessionDir!.split("/").at(-1)!);
    let role: string | undefined, configuration: PiRuntimeConfiguration | undefined;
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(listener) { emit = listener; return () => {}; },
      setRolePrompt(value) { role = value; },
      async configure(value) { configuration = value; },
      async prompt(prompt) {
        records.push({ id, prompt, role, configuration, input });
        emit({ type: "message_start", message: { role: "assistant" } });
        try { await probe?.(input, id, prompt); } catch (failure) { failures.push(failure); throw failure; }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Completed." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() {}, dispose() {}, async newSession() {}, async state() { return { tools: [], models: [] }; },
    };
  };
  return { factory, records, failures };
}

function seed(store: ReturnType<typeof createConversationStore>, id: string, text: string, owner = botA) {
  store.begin(id, "assistant", text);
  store.setExtra(id, { botId: owner });
  const adapter = createPiEventAdapter({ runId: `seed-${id}` });
  adapter.startUserMessage(text);
  adapter.apply({ type: "message_start", message: { role: "assistant" } });
  adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `Answer for ${text}` } });
  adapter.finish("success");
  for (const event of adapter.events) store.append(id, event);
  store.flush(id);
}

test("controller applies each Bot's persona/model and scoped memory/Skill capabilities to its actual model turn", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-bot-enhancements-"));
  const bots = new BotConfigStore(join(dataDir, "bots.json"));
  const memory = createMemoryService({ dataDir });
  const skills = createBotSkillsService({ dataDir });
  const skillA = skills.save({ name: "A review", description: "Review A's evidence", instructions: "PRIVATE_SKILL_A" }, 0).skills[0];
  const skillB = skills.save({ name: "B review", description: "Review B's evidence", instructions: "PRIVATE_SKILL_B" }, 1).skills[1];
  bots.save({ ...profile(botA, "Nova"), role: "Evidence researcher", personality: "Concise and careful", instructions: "Cite primary evidence.", model: { provider: "own-provider", model: "own-model" }, skillIds: [skillA.id] }, 0);
  bots.save({ ...profile(botB, "Mira"), role: "Design reviewer", skillIds: [skillB.id] }, 1);
  memory.add("GLOBAL_MEMORY");
  memory.add("PRIVATE_MEMORY_A", { kind: "bot", id: botA });
  memory.add("PRIVATE_MEMORY_B", { kind: "bot", id: botB });
  memory.add("GROUP_MEMORY", { kind: "group", id: "room" });
  const bridge = observingBridge(async (input, id) => {
    const recall = await input.hostTools!.run("recall_memories", {});
    assert.equal(recall.isError, false);
    const own = id === "a" || id === "group-a" ? skillA : skillB;
    const other = own.id === skillA.id ? skillB : skillA;
    assert.equal((await input.hostTools!.run("read_skill", { id: own.id })).isError, false);
    assert.equal((await input.hostTools!.run("read_skill", { id: other.id })).isError, true);
    if (id === "a") {
      assert.match(recall.text, /GLOBAL_MEMORY|PRIVATE_MEMORY_A/);
      assert.doesNotMatch(recall.text, /PRIVATE_MEMORY_B|GROUP_MEMORY/);
      assert.equal(input.approvalGate.requiresApproval("remember", { text: "new" }), true);
      assert.equal((await input.hostTools!.run("remember", { text: "SAVED_BY_A" })).isError, false);
    }
    if (id === "b") assert.doesNotMatch(recall.text, /PRIVATE_MEMORY_A|SAVED_BY_A|GROUP_MEMORY/);
    if (id === "group-a") {
      assert.match(recall.text, /GROUP_MEMORY/);
      assert.equal((await input.hostTools!.run("remember", { text: "SAVED_IN_GROUP" })).isError, false);
    }
  });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bots, memory, skills, bridgeFactory: bridge.factory });
  try {
    await controller.runPrompt({ conversationId: "a", botId: botA, prompt: "Research A", provider: "caller-provider", model: "caller-model" }, () => {});
    await controller.runPrompt({ conversationId: "b", botId: botB, prompt: "Review B", provider: "caller-provider", model: "caller-model" }, () => {});
    await controller.runPrompt({ conversationId: "group-a", botId: botA, prompt: "Review together" }, () => {}, { groupId: "room", groupConversation: true });
    assert.deepEqual(bridge.failures, []);
    assert.equal(bridge.records.length, 3);
    const [a, b, group] = bridge.records;
    assert.match(a.role!, /Nova[\s\S]*Evidence researcher[\s\S]*Concise and careful[\s\S]*Cite primary evidence/);
    assert.doesNotMatch(b.role!, /Evidence researcher|Cite primary evidence/);
    assert.match(b.role!, /Mira[\s\S]*Design reviewer/);
    assert.equal(a.configuration?.provider, "own-provider");
    assert.equal(a.configuration?.model, "own-model");
    assert.equal(b.configuration?.model, "caller-model");
    assert.match(a.prompt, /PRIVATE_MEMORY_A/);
    assert.doesNotMatch(a.prompt, /PRIVATE_MEMORY_B|GROUP_MEMORY|PRIVATE_SKILL_A|PRIVATE_SKILL_B/);
    assert.match(a.prompt, new RegExp(skillA.id));
    assert.doesNotMatch(a.prompt, new RegExp(skillB.id));
    assert.match(group.prompt, /GROUP_MEMORY/);
    const saved = memory.state().memories;
    assert.deepEqual(saved.find(item => item.text === "SAVED_BY_A")?.scope, { kind: "bot", id: botA });
    assert.deepEqual(saved.find(item => item.text === "SAVED_IN_GROUP")?.scope, { kind: "group", id: "room" });
    assert.equal(saved.find(item => item.text === "SAVED_BY_A")?.source?.botId, botA);
    assert.doesNotMatch(JSON.stringify(controller.getConversation("a")?.events), /PRIVATE_MEMORY_A|Cite primary evidence|PRIVATE_SKILL_A/);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("controller history access requires explicit visible references and retains grants on follow-up and restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-history-grants-"));
  const store = createConversationStore(dataDir);
  const bots = new BotConfigStore(join(dataDir, "bots.json"));
  bots.import([profile(botA, "Nova"), profile(botB, "Mira")]);
  seed(store, "main", "CURRENT_PUBLIC_MARKER");
  seed(store, "source", "OTHER_PUBLIC_MARKER", botB);
  seed(store, "unrelated", "UNRELATED_MARKER", botB);
  seed(store, "room.m.assistant", "HIDDEN_CHILD_MARKER");
  let granted = false;
  const bridge = observingBridge(async input => {
    const tools = input.hostTools!;
    const current = await tools.run("search_chat_history", { query: "CURRENT_PUBLIC_MARKER" });
    assert.equal(current.isError, false);
    assert.match(current.text, /CURRENT_PUBLIC_MARKER/);
    const source = await tools.run("search_chat_history", { query: "OTHER_PUBLIC_MARKER", conversationId: "source" });
    assert.equal(source.isError, !granted);
    if (granted) {
      const match = JSON.parse(source.text).messages[0];
      const read = await tools.run("read_chat_history", { conversationId: "source", textId: match.textId, runId: match.runId });
      assert.equal(read.isError, false);
      assert.match(read.text, /OTHER_PUBLIC_MARKER/);
    }
    for (const conversationId of ["unrelated", "room.m.assistant"]) assert.equal((await tools.run("search_chat_history", { conversationId, query: "MARKER" })).isError, true);
  });
  let controller = createPiRuntimeController({ cwd: dataDir, dataDir, store, bots, bridgeFactory: bridge.factory });
  try {
    await controller.runPrompt({ conversationId: "main", prompt: "Use current history" }, () => {});
    granted = true;
    await controller.runPrompt({ conversationId: "main", prompt: "Compare the referenced chat", referencedConversationIds: ["source"] }, () => {});
    await controller.runPrompt({ conversationId: "main", prompt: "Continue with the same reference" }, () => {});
    assert.match(bridge.records[1].prompt, /User-referenced conversations[\s\S]*"id":"source"/);
    assert.doesNotMatch(bridge.records[1].prompt, /Answer for OTHER_PUBLIC_MARKER/, "full history is fetched only by the tool");
    assert.ok(controller.getConversation("main")?.turns?.some(turn => turn.referencedConversationIds?.includes("source")));
    await assert.rejects(controller.runPrompt({ conversationId: "main", prompt: "Hidden reference", referencedConversationIds: ["room.m.assistant"] }, () => {}), /visible conversations/);
    await assert.rejects(controller.runPrompt({ conversationId: "main", prompt: "Missing reference", referencedConversationIds: ["deleted"] }, () => {}), /unavailable/);
    controller.dispose();
    controller = createPiRuntimeController({ cwd: dataDir, dataDir, bots, bridgeFactory: bridge.factory });
    await controller.runPrompt({ conversationId: "main", prompt: "Resume after restart" }, () => {});
    assert.deepEqual(bridge.failures, []);
    assert.equal(bridge.records.length, 4);
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("delegated controller turns expose only read tools, suppress setup callbacks and reject questions and side effects", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-delegated-boundary-"));
  const bots = new BotConfigStore(join(dataDir, "bots.json"));
  const skills = createBotSkillsService({ dataDir });
  const skill = skills.save({ name: "Review", description: "Review only", instructions: "Inspect the evidence." }, 0).skills[0];
  bots.save({ ...profile(botA, "Nova"), skillIds: [skill.id] }, 0);
  const memory = createMemoryService({ dataDir });
  memory.add("Read-only task context.");
  let extraCalls = 0, channelCalls = 0, routineCalls = 0;
  const bridge = observingBridge(async (input, _id, prompt) => {
    if (!prompt.startsWith("Delegated")) return;
    assert.equal(input.delegated, true);
    assert.equal(input.onChannelSetup, undefined);
    assert.equal(input.onCreateRoutine, undefined);
    assert.deepEqual(input.hostTools!.specs.map(spec => spec.name).sort(), ["read_chat_history", "read_skill", "recall_memories", "search_chat_history"]);
    await assert.rejects(input.onUserInput({ toolCallId: "question", questions: [], signal: new AbortController().signal }), /cannot request user input/);
    for (const name of ["remember", "forget", "publish_artifact", "send_message"]) assert.equal((await input.hostTools!.run(name, { text: "Not allowed" })).isError, true);
    for (const name of ["write", "bash", "remember", "connect_channel", "create_routine", "mcp__server__send"]) {
      await assert.rejects(input.approvalGate.wait(`blocked-${name}`, name, { path: "notes.txt", command: "touch notes.txt" }), /read-only/);
    }
    assert.equal(input.approvalGate.waiting, false, "refused side effects never become user approval requests");
    await input.approvalGate.wait("read", "read", { path: "notes.txt" });
    assert.equal((await input.hostTools!.run("recall_memories", {})).isError, false);
    assert.equal((await input.hostTools!.run("read_skill", { id: skill.id })).isError, false);
  });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bots, memory, skills, bridgeFactory: bridge.factory,
    channelSetup: async () => { channelCalls++; return { status: "cancelled" } as never; },
    createRoutine: () => { routineCalls++; return {} as never; } });
  try {
    await controller.runPrompt({ conversationId: "task", botId: botA, prompt: "Ordinary turn" }, () => {});
    assert.equal(typeof bridge.records[0].input.onChannelSetup, "function");
    assert.equal(typeof bridge.records[0].input.onCreateRoutine, "function");
    await controller.runPrompt({ conversationId: "task", prompt: "Delegated read-only turn", permissionMode: "allow-all" }, () => {}, {
      delegated: true, readOnly: true,
      extraHostTools: { specs: [{ name: "send_message", description: "Must be blocked", inputSchema: {} }], async run() { extraCalls++; return { text: "sent", isError: false }; } },
    });
    assert.deepEqual(bridge.failures, []);
    assert.notEqual(bridge.records[0].input, bridge.records[1].input, "a reused Pi conversation reopens with its restricted tool context");
    assert.equal(extraCalls + channelCalls + routineCalls, 0);
    assert.equal(memory.state().memories.length, 1);
    assert.equal(controller.awaitingUser("task"), false);
    await controller.runPrompt({ conversationId: "task", prompt: "Ordinary follow-up" }, () => {});
    assert.equal(bridge.records[2].input.approvalGate.isRefused("write", { path: "notes.txt" }), false, "read-only restriction belongs to its run");
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("HTTP Skills revisions, memory owner scopes and usage summaries preserve host ownership boundaries", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-enhancements-http-"));
  const bridge = observingBridge();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: bridge.factory, browser: false, routineClock: false });
  const server = createServer((request, response) => { void host.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    assert.equal((await call("/bots/import", { profiles: [profile(botA, "Nova")] })).status, 200);
    assert.deepEqual((await call("/skills")).body, { revision: 0, skills: [] });
    const input = { name: "Review", description: "Before release", instructions: "Check the evidence." };
    const added = await call("/skills", { input, revision: 0 });
    assert.equal(added.status, 200);
    assert.equal((await call("/skills", { input, revision: 0 })).status, 409);
    assert.deepEqual((await call("/skills")).body, added.body);
    const id = added.body.skills[0].id;
    const edited = await call("/skills", { input: { ...input, id, enabled: false }, revision: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.skills[0].enabled, false);
    assert.equal((await call("/skills/remove", { id, revision: 1 })).status, 409);
    assert.deepEqual((await call("/skills/remove", { id, revision: 2 })).body, { revision: 3, skills: [] });
    const privateMemory = await call("/memories", { text: "Bot-specific fact", scope: { kind: "bot", id: botA } });
    assert.equal(privateMemory.status, 201);
    const rewritten = await call(`/memories/${privateMemory.body.memory.id}`, { text: "Edited private fact" });
    assert.deepEqual(rewritten.body.memory.scope, { kind: "bot", id: botA });
    assert.equal((await call("/memories", { text: "Unknown owner", scope: { kind: "bot", id: botB } })).status, 404);
    assert.equal((await call("/memories", { text: "Invalid global", scope: { kind: "global", id: botA } })).status, 400);
    assert.equal((await call("/memories", { text: "Missing group", scope: { kind: "group", id: "missing" } })).status, 404);
    host.controller.setGroupMembers("room", ["assistant", "planner"]);
    assert.equal((await call("/memories", { text: "Real group fact", scope: { kind: "group", id: "room" } })).status, 201);
    assert.deepEqual((await call("/usage")).body.runs, []);
    await host.controller.runPrompt({ conversationId: "usage-chat", requestId: "usage-run", botId: botA, prompt: "Finish without model telemetry" }, () => {});
    const usage = (await call("/usage")).body.runs;
    assert.equal(usage.length, 1);
    assert.equal(usage[0].botId, botA);
    assert.equal(usage[0].runId, "usage-run");
    assert.equal(usage[0].status, "completed");
    assert.equal(usage[0].coverage, "unknown");
    assert.deepEqual(usage[0].totals, {}, "missing gateway token data is never reported as zero usage");
  } finally {
    host.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
