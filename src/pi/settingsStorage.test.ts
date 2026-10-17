import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalMemory } from "./approvalMemory.ts";
import { ChannelStore } from "./imChannels/channelStore.ts";
import { createPiHttpHost } from "./piHost.ts";

test("unreadable settings report errors without disabling the host or overwriting files", async () => {
  for (const invalid of ['{"truncated":', '{}', 'null', '{"memories":[{"id":"broken"}],"routines":[{"id":"broken"}],"servers":[{"id":"broken","url":"https://example.com"}],"channels":{"telegram":{"enabled":true}},"chats":{}}']) {
    const dir = mkdtempSync(join(tmpdir(), "rtb-settings-corrupt-"));
    const files = ["memories.json", "mcp.json", "routines.json", "im-channels.json"];
    for (const file of files) writeFileSync(join(dir, file), invalid);
    let connections = 0;
    const connector = () => { connections++; throw new Error("must not connect"); };
    const host = createPiHttpHost({ cwd: dir, dataDir: dir, browser: false,
      channelFactories: { telegram: connector, feishu: connector, dingtalk: connector, wecom: connector },
      bridgeFactory: async () => ({ subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {},
        configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {} }) });
    const server = createServer((req, res) => { void host.handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
    try {
      assert.equal((await fetch(`${url}/health`)).status, 200);
      for (const endpoint of ["memories", "mcp", "routines", "channels"]) {
        const result = await fetch(`${url}/${endpoint}`);
        assert.equal(result.status, 500, `${endpoint} must not look empty`);
        assert.match((await result.json()).error, /could not be read.*not been changed/i);
      }
      for (const [endpoint, body] of [
        ["memories", { text: "Keep this" }],
        ["mcp", { name: "Probe", url: "https://example.com/mcp", enabled: false }],
        ["routines/missing", { enabled: true }],
        ["channels/telegram", { enabled: true, fields: { botToken: "test-only" } }],
      ] as const) {
        const result = await fetch(`${url}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(result.status, 500, endpoint);
      }
      await host.controller.runPrompt({ conversationId: "healthy", prompt: "hello" }, () => {});
      assert.ok(host.controller.getConversation("healthy")?.events.some(event => event.type === "run.finished"));
      assert.equal(connections, 0);
      for (const file of files) assert.equal(readFileSync(join(dir, file), "utf8"), invalid);
    } finally {
      host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("failed grant and IM writes keep the last committed state and can be retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-settings-write-"));
  const approvalsFile = join(dir, "approvals.json");
  const channelFile = join(dir, "im-channels.json");
  try {
    const approvals = new ApprovalMemory(approvalsFile);
    approvals.add("assistant", "write");
    mkdirSync(`${approvalsFile}.tmp`);
    assert.throws(() => approvals.clear("assistant"));
    assert.equal(approvals.has("assistant", "write"), true);
    assert.throws(() => approvals.add("assistant", "edit"));
    assert.equal(approvals.has("assistant", "edit"), false);
    rmSync(`${approvalsFile}.tmp`, { recursive: true });
    approvals.clear("assistant");
    assert.deepEqual(new ApprovalMemory(approvalsFile).list(), {});

    const channels = new ChannelStore(channelFile);
    channels.update("telegram", { allowUsers: ["original"] });
    channels.bindConversation("telegram:test", "original-chat");
    channels.telegramOffset = 12;
    mkdirSync(`${channelFile}.tmp`);
    assert.throws(() => channels.update("telegram", { allowUsers: ["uncommitted"] }));
    assert.deepEqual(channels.get("telegram").allowUsers, ["original"]);
    assert.throws(() => channels.bindConversation("telegram:test", "uncommitted-chat"));
    assert.equal(channels.conversationFor("telegram:test"), "original-chat");
    assert.throws(() => { channels.telegramOffset = 99; });
    assert.equal(channels.telegramOffset, 12);
    rmSync(`${channelFile}.tmp`, { recursive: true });
    channels.telegramOffset = 13;
    assert.equal(new ChannelStore(channelFile).telegramOffset, 13);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a settings path that cannot be read is preserved, not treated as missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-settings-read-"));
  const file = join(dir, "im-channels.json");
  try {
    mkdirSync(file);
    const store = new ChannelStore(file);
    assert.throws(() => store.update("telegram", { enabled: false }), /could not be read/);
    renameSync(file, `${file}.original`);
    assert.throws(() => store.update("telegram", { enabled: false }), /could not be read/, "repair requires an explicit reload, not an overwrite");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
