import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConversationStore } from "./conversationStore.ts";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { validBranchMetadata } from "./conversationBranch.ts";

test("branching preserves the original, excludes the selected run, and keeps its actual submission", () => {
  const dir = mkdtempSync(join(tmpdir(), "raytone-branch-store-"));
  try {
    const store = createConversationStore(dir);
    store.begin("source", "assistant", "Original title");
    for (const runId of ["first", "second"]) {
      store.saveTurn("source", { runId, harness: "pi", prompt: `Original ${runId}`,
        attachments: runId === "second" ? [{ scope: "assistant", path: "input.txt", name: "原附件.txt" }] : undefined });
      store.saveNativeTurn("source", runId, { harness: "pi", sessionId: "native", sourceId: "source", beforeEntryId: runId === "first" ? null : "first-reply" });
      const adapter = createPiEventAdapter({ runId, onEvent: event => store.append("source", event) });
      adapter.startUserMessage(`Original ${runId}`); adapter.finish("success"); store.flush("source");
    }
    const original = readFileSync(join(store.dir, "source.json"), "utf8");
    const { conversation, draft } = store.branch("child", "source", "second");
    assert.ok(conversation.events.every(event => event.runId === "first"));
    assert.deepEqual(conversation.branch?.native, { harness: "pi", sessionId: "native", sourceId: "source", entryId: "first-reply" });
    assert.deepEqual(draft, { prompt: "Original second", attachments: [{ scope: "assistant", path: "input.txt", name: "原附件.txt" }] });
    assert.equal(conversation.piSessionId, null);
    assert.equal(conversation.cliSession, undefined);
    assert.deepEqual(createConversationStore(dir).get("child"), JSON.parse(JSON.stringify(conversation)));
    const fresh = store.branch("fresh", "source", "first").conversation;
    assert.deepEqual(fresh.events, []);
    assert.equal(fresh.branch?.native, undefined);
    assert.throws(() => store.branch("child", "source", "second"), /already exists/);
    assert.throws(() => store.branch("unknown", "source", "unknown"), /no saved branch/);
    mkdirSync(join(store.dir, "failed.json.tmp"));
    assert.throws(() => store.branch("failed", "source", "second"), /could not be saved/);
    assert.equal(store.get("failed"), undefined);
    assert.equal(readFileSync(join(store.dir, "source.json"), "utf8"), original);
    assert.throws(() => store.saveNativeTurn("source", "first", { harness: "pi", sessionId: "--invalid", sourceId: "source", beforeEntryId: null }), /Invalid native/);
    assert.equal(readFileSync(join(store.dir, "source.json"), "utf8"), original);
    assert.throws(() => store.saveTurn("source", { runId: "first", harness: "pi", prompt: "duplicate" }), /already been submitted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch route checks source activity and origin, and never executes the new draft", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const dir = mkdtempSync(join(tmpdir(), "raytone-branch-http-"));
  let starts = 0, release = () => {};
  const host = createPiHttpHost({ cwd: dir, dataDir: dir, bridgeFactory: async () => ({
    subscribe: () => () => {}, prompt: async () => { starts++; await new Promise<void>(resolve => { release = resolve; }); },
    abort: async () => release(), dispose: () => release(), configure: async () => {}, newSession: async () => {},
    state: async () => ({ models: [], tools: [] }),
  }) });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const branch = (origin?: string, beforeRunId = "first") => fetch(`${base}/conversations/source/branch`, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ beforeRunId }),
  });
  try {
    const running = host.controller.runPrompt({ conversationId: "source", requestId: "first", prompt: "Original draft" }, () => {});
    while (!starts) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await branch()).status, 409);
    assert.equal((await branch("https://untrusted.example")).status, 403);
    release(); await running;
    const sourceFile = join(dir, "conversations", "source.json"), original = readFileSync(sourceFile, "utf8");
    const response = await branch(); assert.equal(response.status, 201);
    const body = await response.json(); assert.equal(body.draft.prompt, "Original draft");
    assert.deepEqual(host.controller.getConversation(body.conversationId)?.events, []);
    assert.equal(starts, 1);
    assert.equal((await branch(undefined, "")).status, 400);
    assert.equal((await branch(undefined, "unknown")).status, 409);
    await assert.rejects(host.controller.runPrompt({ conversationId: "source", requestId: "first", prompt: "Duplicate" }, () => {}), /already been submitted/);
    for (const conversationId of [".", ".."]) await assert.rejects(host.controller.runPrompt({ conversationId, prompt: "Invalid path" }, () => {}), /conversationId is invalid/);
    assert.equal(readFileSync(sourceFile, "utf8"), original);
    assert.equal(host.controller.health().activeRuns, 0);
    assert.equal(validBranchMetadata([], { sourceId: "..", beforeRunId: "first" }), false);
    assert.equal(validBranchMetadata([{ runId: "x", harness: "pi", prompt: "x", native: { harness: "pi", sessionId: "--flag", sourceId: "source", beforeEntryId: null } }], undefined), false);
  } finally { host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
