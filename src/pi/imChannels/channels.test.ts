import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { InboundMessage } from "./channelBridge.ts";
import { ChannelStore } from "./channelStore.ts";
import { telegramConnector } from "./connectors/telegram.ts";
import type { ConnectorFactories } from "./channelManager.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("Telegram skips the backlog on first start, strips the bot mention and edits one reply in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-telegram-"));
  const calls: { method: string; body: Record<string, any> }[] = [];
  let polls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return ok({ id: 9, username: "rtb_bot" });
    if (method === "getUpdates" && body.offset === -1) return ok([{ update_id: 41 }]);
    if (method === "getUpdates") {
      if (polls++ === 0) return ok([{ update_id: 42, message: { message_id: 5, chat: { id: -100, type: "group" }, from: { id: 7, username: "ann" }, text: "@rtb_bot hello" } }]);
      await new Promise((resolve) => init.signal!.addEventListener("abort", resolve));
      throw new Error("aborted");
    }
    if (method === "sendMessage") return ok({ message_id: 77 });
    return ok(true);
  }) as typeof fetch;
  const store = new ChannelStore(join(dir, "im-channels.json"));
  const received: InboundMessage[] = [];
  const connector = telegramConnector({ credentials: { botToken: "t" }, store, onMessage: (message) => received.push(message), onState: () => {} }, fetcher);
  try {
    assert.deepEqual(await connector.start(), { botName: "@rtb_bot" });
    await tick();
    assert.equal(calls.find((call) => call.method === "getUpdates" && call.body.offset !== -1)!.body.offset, 42);
    assert.equal(store.telegramOffset, 43);
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "hello");
    assert.equal(received[0].mentioned, true);
    assert.equal(received[0].senderId, "7");
    const stream = await received[0].reply.stream!("思考中…");
    await stream.finish("done");
    const edit = calls.find((call) => call.method === "editMessageText")!;
    assert.deepEqual([edit.body.message_id, edit.body.text], [77, "done"]);
  } finally {
    await connector.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the channels endpoint saves settings, reports status, and never returns a saved secret", async () => {
  const { createPiHttpHost } = await import("../piHost.ts");
  const dir = mkdtempSync(join(tmpdir(), "rtb-channels-http-"));
  const started: Record<string, string>[] = [];
  const fail = { start: async () => { throw new Error("bad credentials"); }, stop: () => {} };
  const factories: ConnectorFactories = {
    telegram: (input) => ({ start: async () => { started.push(input.credentials); return { botName: "@rtb_bot" }; }, stop: () => {} }),
    feishu: () => fail, dingtalk: () => fail, wecom: () => fail,
  };
  const host = createPiHttpHost({ cwd: dir, dataDir: dir, channelFactories: factories, bridgeFactory: async () => { throw new Error("unused"); } });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/channels`;
  const post = (platform: string, body: unknown) => fetch(`${base}/${platform}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const saved = await (await post("telegram", { enabled: true, fields: { botToken: "123:secret" }, allowUsers: ["7"], unknown: "x" })).json();
    assert.doesNotMatch(JSON.stringify(saved), /123:secret/);
    await tick();
    const listed = (await (await fetch(base)).json()).channels.find((channel: { platform: string }) => channel.platform === "telegram");
    assert.deepEqual([listed.enabled, listed.secretsSet.botToken, listed.status.state, listed.status.botName, listed.allowUsers], [true, true, "connected", "@rtb_bot", ["7"]]);
    assert.deepEqual(started, [{ botToken: "123:secret" }]);
    await post("telegram", { access: "open" });
    assert.equal(started.length, 1, "access changes apply without reconnecting");
    await post("feishu", { enabled: true, fields: { appId: "cli_1", appSecret: "s" } });
    await tick();
    const feishu = (await (await fetch(base)).json()).channels.find((channel: { platform: string }) => channel.platform === "feishu");
    assert.deepEqual([feishu.status.state, feishu.status.error, feishu.fields.appId, feishu.fields.appSecret], ["error", "bad credentials", "cli_1", ""]);
    assert.equal((await post("slack", {})).status, 404);
  } finally {
    host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connect_channel: the token goes from the card to the channel store, never into events, transcript or the tool result", async () => {
  const { createPiHttpHost } = await import("../piHost.ts");
  const dir = mkdtempSync(join(tmpdir(), "rtb-setup-"));
  const TOKEN = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
  let deliver: ((message: InboundMessage) => void) | undefined;
  const fail = { start: async () => { throw new Error("unused"); }, stop: () => {} };
  const factories: ConnectorFactories = {
    telegram: (input) => ({ async start() {
      if (input.credentials.botToken !== TOKEN) throw new Error("Telegram getMe: Unauthorized");
      deliver = input.onMessage;
      return { botName: "@rtb_bot" };
    }, stop: () => {} }),
    feishu: () => fail, dingtalk: () => fail, wecom: () => fail,
  };
  const results: unknown[] = [];
  const host = createPiHttpHost({ cwd: dir, dataDir: dir, channelFactories: factories, bridgeFactory: async (input) => ({
    subscribe: () => () => undefined,
    async prompt(text) { if (text.includes("connect")) results.push(await input.onChannelSetup!({ toolCallId: "t1", platform: "telegram", signal: new AbortController().signal })); },
    abort: async () => undefined, dispose: () => undefined, configure: async () => undefined,
    state: async () => ({ models: [], tools: [] }) as never, newSession: async () => undefined,
  }) });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const answer = (body: Record<string, unknown>) => fetch(`${base}/channels/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events: { type: string; payload: Record<string, any> }[] = [];
  try {
    const run = host.controller.runPrompt({ conversationId: "web-1", requestId: "r1", prompt: "connect my telegram" }, (event) => events.push(event as never));
    await tick();
    const card = () => events.filter((event) => event.type === "run.awaiting_input").at(-1)!.payload;
    assert.equal(card().channelSetup.stage, "credentials");
    const requestId = card().requestId;
    const wrong = await answer({ conversationId: "web-1", requestId, action: "submit", fields: { botToken: "1:bad" } });
    assert.equal(wrong.status, 400);
    assert.match(card().channelSetup.error, /Unauthorized/);
    const afterWrong = (await (await fetch(`${base}/channels`)).json()).channels.find((entry: { platform: string }) => entry.platform === "telegram");
    assert.deepEqual([afterWrong.enabled, afterWrong.secretsSet.botToken], [false, false], "a failed token leaves the earlier settings in place");
    assert.equal((await answer({ conversationId: "other", requestId, action: "submit", fields: { botToken: TOKEN } })).status, 409, "another conversation cannot answer");
    assert.equal((await answer({ conversationId: "web-1", requestId, action: "submit", fields: { botToken: TOKEN } })).status, 200);
    assert.deepEqual([card().channelSetup.stage, card().channelSetup.botName], ["pairing", "@rtb_bot"]);

    const replies: string[] = [];
    deliver!({ messageId: "m1", chatId: "7", chatType: "direct", senderId: "7", senderName: "@ann", text: "hi", mentioned: true,
      reply: { send: async (text) => { replies.push(text); } } });
    await tick();
    assert.match(replies[0], /允许/);
    assert.deepEqual(card().channelSetup.candidate, { id: "7", name: "@ann" });
    assert.equal((await answer({ conversationId: "web-1", requestId, action: "allow" })).status, 200);
    await run;
    assert.deepEqual(results, [{ status: "connected", platform: "telegram", bot: "@rtb_bot", allowedUser: "@ann" }]);
    const channel = (await (await fetch(`${base}/channels`)).json()).channels.find((entry: { platform: string }) => entry.platform === "telegram");
    assert.deepEqual([channel.enabled, channel.allowUsers, channel.secretsSet.botToken], [true, ["7"], true]);
    assert.ok(events.some((event) => event.type === "tool.call.progress" && event.payload.inputRequestId === requestId), "the card closes");
    const transcript = JSON.stringify(host.controller.getConversation("web-1"));
    assert.ok(!JSON.stringify(events).includes(TOKEN) && !transcript.includes(TOKEN) && !JSON.stringify(results).includes(TOKEN));

    // A token typed into chat is cut before it is saved or reaches the model.
    await host.controller.runPrompt({ conversationId: "web-2", requestId: "r2", prompt: `my token ${TOKEN}` }, () => {});
    assert.ok(!JSON.stringify(host.controller.getConversation("web-2")).includes(TOKEN));
    // An IM chat gets no card: credentials are never collected there.
    await host.controller.runPrompt({ conversationId: "im-telegram-x", requestId: "r3", prompt: "connect" }, () => {});
    assert.equal((results.at(-1) as { status: string }).status, "open_in_browser");
  } finally {
    host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
