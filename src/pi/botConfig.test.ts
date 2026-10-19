import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { BotConfigStore } from "./botConfig.ts";
import { DEFAULT_NEW_BOT } from "../runtime/botAppearance.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { createConversationStore } from "./conversationStore.ts";
import type { ConnectorInput } from "./imChannels/connectors/connector.ts";
import type { RoutineView } from "./routineTypes.ts";

const custom = { id: "bot_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", presetId: "assistant" as const, name: "Nova", appearance: DEFAULT_NEW_BOT };
const definition = { id: "bot-sync-test", name: "Bot sync test", protocol: "openai-compatible" as const,
  baseUrl: "https://models.example.test/v1", models: ["controlled"], authMode: "required" as const, apiKeyEnvVar: "BOT_SYNC_TEST_KEY" };
const request = { title: "Daily check", schedule: "0 9 * * *", timezone: "UTC", instructions: "Check status" };
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, "controlled operation timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("Bot migration is idempotent, server edits win, revisions protect stale saves, and disk failures preserve state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-bot-config-"));
  const path = join(dir, "bots.json");
  try {
    let store = new BotConfigStore(path);
    const planner = { ...store.require("planner"), name: "tony" };
    const first = store.import([planner, custom]);
    assert.equal(store.import([{ ...planner, name: "Tonny" }, custom]).revision, first.revision);
    assert.equal(store.require("planner").name, "tony");
    store.save({ ...planner, name: "Tony Renamed" }, first.revision);
    assert.throws(() => store.save({ ...planner, name: "Stale" }, first.revision), /其他页面/);
    assert.throws(() => store.save({ ...custom, presetId: "builder" }, store.view().revision), /engine cannot change/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store = new BotConfigStore(path);
    assert.equal(store.require("planner").name, "Tony Renamed");
    assert.deepEqual(store.require(custom.id).appearance, DEFAULT_NEW_BOT);
    mkdirSync(`${path}.tmp`);
    assert.throws(() => store.save({ ...custom, name: "Not saved" }, store.view().revision));
    assert.equal(store.require(custom.id).name, "Nova");
    assert.throws(() => store.input({ prompt: "x", botId: custom.id, agentPreset: "builder" }), /engine/);
    assert.throws(() => store.input({ prompt: "x", botId: "missing" }), /Unknown Bot/);
    assert.throws(() => store.input({ prompt: "x", botId: custom.id }, { botId: "assistant" } as never), /identity cannot change/);
    writeFileSync(path, '{"broken":');
    const broken = new BotConfigStore(path);
    assert.throws(() => broken.view(), /could not be read/);
    assert.throws(() => broken.import([custom]), /could not be read/);
    assert.equal(readFileSync(path, "utf8"), '{"broken":');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function hostFor(dir: string) {
  const systems: { id: string; text: string }[] = [], prompts: { id: string; text: string }[] = [];
  const created: RoutineView[] = [];
  let connected: ConnectorInput | undefined;
  const connector = (input: ConnectorInput) => { connected = input; return { start: async () => ({ botName: "PlatformAccount" }), stop() {} }; };
  const factory: PiBridgeFactory = async ({ sessionDir, onCreateRoutine }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; }, setRolePrompt(text) { systems.push({ id, text }); },
      async prompt(text) {
        prompts.push({ id, text });
        emit({ type: "message_start", message: { role: "assistant" } });
        if (text.startsWith("Create schedule")) created.push(await onCreateRoutine!(request));
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      }, async configure() {}, async newSession() {}, async abort() {}, dispose() {}, async state() { return { tools: [], models: [] }; },
    };
  };
  const host = createPiHttpHost({ cwd: dir, dataDir: dir, bridgeFactory: factory, browser: false, routineClock: false,
    channelFactories: { telegram: connector, feishu: connector, dingtalk: connector, wecom: connector } });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const call = async (path: string, body?: unknown, origin?: string) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  let messageId = 0;
  const sendIM = async (text: string) => {
    await until(() => Boolean(connected));
    const replies: string[] = [];
    connected!.onMessage({ messageId: String(++messageId), chatId: "chat", chatType: "direct", senderId: "owner", mentioned: true, text,
      reply: { send: async text => { replies.push(text); } } });
    await until(() => replies.length > 0);
    assert.match(replies.at(-1)!, /Done/);
  };
  return { host, systems, prompts, created, call, sendIM,
    close: async () => { host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("HTTP migration preserves historical Bot ownership, rejects cross-origin and stale edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-bot-http-"));
  const history = createConversationStore(dir);
  history.begin("legacy", "assistant", "old");
  history.begin("owned", "assistant", "old"); history.setExtra("owned", { botId: "assistant" });
  const api = await hostFor(dir);
  try {
    assert.equal((await api.call("/bots/import", { profiles: [custom] }, "https://foreign.test")).status, 403);
    assert.equal((await api.call("/bots/import", { profiles: [{ ...custom, name: "invalid\nname" }] })).status, 400);
    const migrated = await api.call("/bots/import", { profiles: [custom], conversations: { legacy: custom.id, owned: custom.id } });
    assert.equal(migrated.status, 200);
    assert.equal(api.host.controller.getConversation("legacy")?.botId, custom.id);
    assert.equal(api.host.controller.getConversation("owned")?.botId, "assistant");
    const save = await api.call("/bots", { bot: { ...custom, name: "Current" }, revision: migrated.body.revision });
    assert.equal(save.status, 200);
    assert.equal((await api.call("/bots", { bot: custom, revision: migrated.body.revision })).status, 409);
    await api.host.controller.runPrompt({ conversationId: "legacy", prompt: "Continue", availableBots: [{ ...custom, name: "Stale" }] }, () => {});
    assert.match(api.systems.at(-1)!.text, /You are Current/);
    assert.doesNotMatch(api.systems.at(-1)!.text, /Stale/);
    assert.equal((await api.call("/channels/telegram", { botId: "unknown" })).status, 400);
  } finally { await api.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("one server Bot identity reaches web, IM, routines and group prompts after rename and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-bot-entries-"));
  let api = await hostFor(dir);
  try {
    await api.call("/bots/import", { profiles: [custom] });
    await api.host.controller.configure({ conversationId: "web", providerDefinition: definition, provider: definition.id, model: "controlled" });
    await api.host.controller.runPrompt({ conversationId: "web", botId: custom.id, prompt: "Create schedule", provider: definition.id, model: "controlled" }, () => {});
    const routine = api.created[0];
    assert.equal(routine.botId, custom.id);
    assert.equal((await api.call("/channels/telegram", { botId: custom.id, access: "allowlist", allowUsers: ["owner"], enabled: true, fields: { botToken: "test-only" } })).status, 200);
    await api.sendIM("Hello");
    const imId = api.prompts.at(-1)!.id;
    assert.equal(api.host.controller.getConversation(imId)?.botId, custom.id);
    const rename = async (name: string) => {
      const current = (await api.call("/bots")).body;
      assert.equal((await api.call("/bots", { bot: { ...custom, name }, revision: current.revision })).status, 200);
    };
    await rename("星河");
    await api.sendIM("Continue");
    assert.equal(api.prompts.at(-1)!.id, imId, "rename preserves the IM conversation");
    assert.match(api.systems.at(-1)!.text, /You are 星河/);
    await api.host.controller.runPrompt({ conversationId: "web", prompt: "Continue", availableBots: [custom] }, () => {});
    assert.match(api.systems.at(-1)!.text, /You are 星河/);
    await api.call(`/routines/${routine.id}`, { enabled: true });
    assert.equal((await api.call(`/routines/${routine.id}/run`, { occurrenceId: "before-restart" })).status, 202);
    await until(() => api.prompts.some(p => p.id === routine.conversationId));
    assert.match(api.systems.filter(p => p.id === routine.conversationId).at(-1)!.text, /You are 星河/);
    assert.equal(api.host.controller.getConversation(routine.conversationId)?.botId, custom.id);
    // Menu and natural invitation ignore stale caller catalogs and use the saved Bot roster.
    api.host.controller.setGroupMembers("room", ["assistant", custom.id], [custom]);
    await api.host.controller.runGroupPrompt({ conversationId: "room", prompt: "@星河 你好", availableBots: [custom] }, () => {});
    assert.ok(api.systems.some(p => p.id.includes(custom.id) && /You are 星河/.test(p.text)));
    await api.host.controller.runPrompt({ conversationId: "invite", prompt: "把星河拉进来看看问题", availableBots: [] }, () => {});
    assert.ok(api.host.controller.getConversation("invite")?.group?.members.includes(custom.id));
    await api.close(); api = await hostFor(dir);
    await rename("Nova Again");
    await api.sendIM("After restart");
    assert.equal(api.prompts.at(-1)!.id, imId);
    assert.match(api.systems.at(-1)!.text, /You are Nova Again/);
    assert.equal((await api.call(`/routines/${routine.id}/run`, { occurrenceId: "after-restart" })).status, 202);
    await until(() => api.prompts.some(p => p.id === routine.conversationId));
    assert.match(api.systems.filter(p => p.id === routine.conversationId).at(-1)!.text, /You are Nova Again/);
    await api.sendIM("把Raer拉进来看看问题");
    assert.equal(api.host.controller.getConversation(imId)?.group?.hostId, custom.id);
    await api.sendIM("@Nova Again 继续");
    assert.equal(api.host.controller.getConversation(imId)?.botId, custom.id);
    assert.ok(api.prompts.at(-1)!.id.startsWith(imId), "IM group continuation stays in the same room");
    await api.call("/channels/telegram", { botId: "assistant" });
    await api.sendIM("Different Bot");
    assert.notEqual(api.prompts.at(-1)!.id, imId, "switching Bot starts separate IM context");
    assert.equal(api.host.controller.getConversation(api.prompts.at(-1)!.id)?.botId, "assistant");
  } finally { await api.close(); rmSync(dir, { recursive: true, force: true }); }
});
