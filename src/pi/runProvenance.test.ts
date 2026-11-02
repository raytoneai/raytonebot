import { authenticatedFetch } from "./controlPlaneTestSupport.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validRunProvenance, runProvenance } from "./runProvenance.ts";
import { createConversationStore } from "./conversationStore.ts";
import { createPiHttpHost, createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import { ChannelBridge } from "./imChannels/channelBridge.ts";
import { ChannelStore } from "./imChannels/channelStore.ts";
import { createRoutineService } from "./routines.ts";

const factory: PiBridgeFactory = async () => ({
  subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {},
  configure: async () => {}, newSession: async () => {}, state: async () => ({ models: [], tools: [] }),
});

test("provenance validates bounded exact fields, all effective modes, and legacy turns after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-provenance-schema-"));
  try {
    const store = createConversationStore(dir);
    store.begin("c", "assistant", "Metadata");
    store.saveTurn("c", { runId: "legacy", prompt: "Old turn", harness: "pi" });
    for (const permissionMode of ["request", "auto", "allow-all"] as const) {
      const provenance = runProvenance({ origin: { kind: "web" } }, permissionMode)!;
      assert.equal(validRunProvenance(provenance), true);
      store.saveTurn("c", { runId: permissionMode, prompt: "New turn", harness: "pi", provenance });
    }
    const good = { origin: { kind: "im", platform: "telegram", requesterId: "actual-owner" }, permissionMode: "auto", requestedPermissionMode: "request", readOnly: true,
      parent: { conversationId: "group", runId: "root-run", taskId: "assignment" } };
    assert.equal(validRunProvenance(good), true);
    for (const invalid of [
      { ...good, extra: "untrusted" }, { ...good, permissionMode: "unrecognized" }, { ...good, readOnly: "true" },
      { ...good, requestedPermissionMode: "auto" }, { ...good, parent: { conversationId: "x", runId: "x", extra: "x" } },
      { ...good, origin: { kind: "web", requesterId: "forged" } }, { ...good, origin: { kind: "im", platform: "other", requesterId: "owner" } },
      { ...good, origin: { kind: "im", platform: "telegram", requesterId: "x".repeat(321) } },
      { ...good, origin: { kind: "routine", routineId: "id", occurrenceId: "\n" } },
    ]) {
      assert.equal(validRunProvenance(invalid), false);
      assert.throws(() => store.saveTurn("c", { runId: "invalid", harness: "pi", prompt: "Bad", provenance: invalid as never }), /Invalid saved turn/);
    }
    assert.equal(runProvenance(undefined, "request"), undefined);
    const loaded = createConversationStore(dir).get("c")!;
    assert.equal(loaded.turns?.[0].provenance, undefined);
    assert.deepEqual(loaded.turns?.slice(1).map(turn => turn.provenance?.permissionMode), ["request", "auto", "allow-all"]);
    assert.equal(loaded.turns?.length, 4);
    writeFileSync(join(dir, "conversations", "c.json"), JSON.stringify({ ...loaded,
      turns: [{ ...loaded.turns![1], provenance: { origin: { kind: "im", platform: "forged", requesterId: "owner" }, permissionMode: "request" } }] }));
    const corrupted = createConversationStore(dir);
    assert.throws(() => corrupted.get("c"), /could not be read/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP determines web origin and ignores forged source, parent and policy metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-provenance-http-"));
  const host = createPiHttpHost({ cwd: dir, dataDir: dir, bridgeFactory: factory, browser: false, routineClock: false });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const authFetch = await authenticatedFetch(host, base);
  try {
    for (const [route, conversationId, prompt] of [["prompt", "web", "Hello"], ["group/prompt", "group_web", "@Raer hello"]]) {
      const response = await authFetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        conversationId, requestId: `run_${conversationId}`, prompt, members: ["assistant"], permissionMode: "allow-all",
        authorization: { requestedBy: "user_session", authorizedVia: "forged", scope: "developer", version: 1, at: 1 },
        origin: { kind: "im", platform: "telegram", requesterId: "spoofed" }, parent: { conversationId: "forged", runId: "forged" }, readOnly: true,
        provenance: { origin: { kind: "routine", routineId: "forged", occurrenceId: "forged" }, permissionMode: "request" },
      }) });
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      assert.equal(events.at(-1)?.type, "run.finished", JSON.stringify(events));
      const saved = host.controller.getConversation(conversationId)!;
      const provenance = saved.turns?.[0].provenance!;
      assert.deepEqual(provenance, { origin: { kind: "web" }, permissionMode: "allow-all", authorization: provenance.authorization });
      assert.equal(provenance.authorization?.requestedBy, "user_session");
      assert.equal(provenance.authorization?.scope, "user");
      assert.match(provenance.authorization!.authorizedVia, /^[a-f0-9-]{36}$/);
      assert.notEqual(provenance.authorization!.authorizedVia, "forged");
      assert.ok(provenance.authorization!.at > 1);
    }
    await host.controller.runPrompt({ conversationId: "internal", requestId: "internal-run", prompt: "Internal unknown source" }, () => {});
    assert.equal(host.controller.getConversation("internal")?.turns?.[0].provenance, undefined);
    const storedResponse = await authFetch(`${base}/conversations/web`);
    assert.match(await storedResponse.text(), /"origin":\{"kind":"web"\}/);
  } finally { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("allowlisted IM sender and routine occurrence reach durable turn metadata through actual host entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-provenance-source-"));
  const controller = createPiRuntimeController({ cwd: dir, dataDir: dir, bridgeFactory: factory });
  const channels = new ChannelStore(join(dir, "channels.json"));
  channels.update("telegram", { access: "allowlist", allowUsers: ["actual-owner"] });
  const bridge = new ChannelBridge({ platform: "telegram", store: channels, settings: () => channels.get("telegram"), runtime: controller,
    defaultPermissionMode: "allow-all", onDenied() {} });
  const routine = createRoutineService({ dataDir: dir, runtime: controller, permissionMode: "auto" });
  try {
    const send = (senderId: string) => bridge.handle({ messageId: `message_${senderId}`, chatId: "chat", chatType: "direct", senderId, mentioned: true, text: "Hello", reply: { send: async () => {} } });
    await send("stranger"); assert.equal(controller.listConversations().length, 0);
    await send("actual-owner");
    const im = controller.listConversations()[0];
    assert.deepEqual(controller.getConversation(im.id)?.turns?.[0].provenance, { origin: { kind: "im", platform: "telegram", requesterId: "actual-owner" }, permissionMode: "allow-all" });
    const created = routine.create({ title: "Check", instructions: "Read the task", schedule: "0 9 * * *", timezone: "UTC", fromConversationId: "chat",
      model: { definition: { id: "fixture", name: "Fixture", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", models: ["fixture"], authMode: "none" }, model: "fixture" } });
    routine.update(created.id, { enabled: true });
    const run = await routine.run(created.id, "actual-occurrence");
    assert.deepEqual(controller.getConversation(run.conversationId)?.turns?.[0].provenance, { origin: { kind: "routine", routineId: created.id, occurrenceId: "actual-occurrence" }, permissionMode: "auto" });
    const deadline = Date.now() + 2_000;
    while (routine.list()[0].lastRun?.status === "running") {
      assert.ok(Date.now() < deadline, "routine completion did not settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(routine.list()[0].lastRun?.status, "success");
    const reloaded = createConversationStore(dir);
    assert.deepEqual(reloaded.get(im.id)?.turns?.[0].provenance?.origin, { kind: "im", platform: "telegram", requesterId: "actual-owner" });
  } finally { await controller.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
