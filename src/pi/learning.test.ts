import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createLearningService, learningEvidence } from "./learning/service.ts";
import { reviewLearning } from "./learning/review.ts";
import type { PiProviderDefinition } from "./piClient.ts";
import type { AgentUXEvent } from "@agent-ux/protocol";
const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "raytone-learning-"));
  const service = createLearningService({ dataDir, busy: () => false, delayMs: 1 });
  const enable = () => service.update({ action: "settings", revision: service.state().revision, enabled: true, reuse: false, dailyLimit: 1 });
  return { dataDir, service, enable, cleanup() { service.dispose(); rmSync(dataDir, { recursive: true, force: true }); } };
};
const proposal = { title: "CSV validation", trigger: "CSV export", lesson: "Parse the exported CSV and verify its headers before reporting success." };
const source = { conversationId: "chat", runId: "run", botId: "bot", harness: "pi", evidence: "untrusted excerpt" };
async function until(done: () => boolean) { for (let i = 0; i < 100 && !done(); i++) await pause(5); assert.ok(done()); }

test("RSL disabled makes no calls; enabled proposals require approval and reuse is scoped", async () => {
  const f = fixture(); let calls = 0;
  const job = { ...source, review: async () => { calls++; return { proposal, inputTokens: 100, outputTokens: 40 }; } };
  try {
    f.service.enqueue(job); await pause(10); assert.equal(calls, 0);
    f.enable(); f.service.enqueue(job); f.service.enqueue(job);
    await until(() => f.service.state().candidates.length === 1);
    assert.equal(calls, 1); assert.equal(f.service.state().inputTokens, 100);
    assert.equal(f.service.noteFor("bot", "pi", "CSV export"), undefined);
    const id = f.service.state().candidates[0].id;
    f.service.update({ action: "review", revision: f.service.state().revision, id, status: "approved" });
    f.service.update({ action: "settings", revision: f.service.state().revision, enabled: true, reuse: true, dailyLimit: 1 });
    assert.match(f.service.noteFor("bot", "pi", "CSV export")!, /Parse the exported/);
    assert.equal(f.service.noteFor("other", "pi", "CSV export"), undefined);
    assert.equal(f.service.noteFor("bot", "codex", "CSV export"), undefined);
    assert.equal(f.service.noteFor("bot", "pi", "hello"), undefined);
    f.service.enqueue({ ...job, runId: "second" }); await pause(10); assert.equal(calls, 1);
    f.service.update({ action: "review", revision: f.service.state().revision, id, status: "rejected" });
    assert.equal(f.service.noteFor("bot", "pi", "CSV export"), undefined);
    assert.throws(() => f.service.update({ action: "review", revision: 0, id, status: "approved" }), /changed/);
  } finally { f.cleanup(); }
});

test("RSL foreground interruption and disabling prevent late proposals; usage remains visible", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.enable(); f.service.enqueue({ ...source, review: async () => { await new Promise<void>(resolve => { release = resolve; }); return { proposal, inputTokens: 10, outputTokens: 5 }; } });
    await until(() => Boolean(release));
    f.service.interrupt(); f.service.update({ action: "settings", revision: f.service.state().revision, enabled: false, reuse: false, dailyLimit: 1 });
    release(); await until(() => !f.service.state().running);
    assert.equal(f.service.state().candidates.length, 0); assert.equal(f.service.state().inputTokens, 10);
    assert.equal(f.service.state().queued, 0);
  } finally { f.cleanup(); }
});

test("RSL corrupt storage is preserved; calls and candidates survive restart", async () => {
  const f = fixture();
  try {
    f.enable(); f.service.enqueue({ ...source, review: async () => ({ proposal }) });
    await until(() => f.service.state().candidates.length === 1);
    const reopened = createLearningService({ dataDir: f.dataDir, busy: () => false });
    assert.equal(reopened.state().calls, 1); assert.equal(reopened.state().unknownUsage, 1); reopened.dispose();
    writeFileSync(join(f.dataDir, "learning/state.json"), "broken");
    const broken = createLearningService({ dataDir: f.dataDir, busy: () => false });
    assert.ok(broken.state().storageError); assert.equal(broken.noteFor("bot", "pi", "CSV"), undefined);
    assert.throws(() => broken.update({ action: "settings", revision: 0, enabled: true, reuse: false, dailyLimit: 1 }), /storage/);
    assert.equal(readFileSync(join(f.dataDir, "learning/state.json"), "utf8"), "broken"); broken.dispose();
  } finally { f.cleanup(); }
});

test("RSL write failure and model failure stay contained; busy host defers work", async () => {
  const f = fixture(); let busy = true, calls = 0;
  const service = createLearningService({ dataDir: f.dataDir, busy: () => busy, delayMs: 1 });
  try {
    service.update({ action: "settings", revision: 0, enabled: true, reuse: false, dailyLimit: 1 });
    service.enqueue({ ...source, review: async () => { calls++; throw new Error("private provider error"); } });
    await pause(15); assert.equal(calls, 0);
    busy = false; await until(() => service.state().calls === 1 && !service.state().running);
    assert.equal(service.state().unknownUsage, 1); assert.doesNotMatch(service.state().lastResult!, /private/);
    rmSync(join(f.dataDir, "learning/state.json")); mkdirSync(join(f.dataDir, "learning/state.json"));
    assert.throws(() => service.update({ action: "settings", revision: service.state().revision, enabled: false, reuse: false, dailyLimit: 1 }), /storage/);
    assert.ok(service.state().storageError);
  } finally { service.dispose(); f.cleanup(); }
});

test("RSL evidence omits reasoning/tools/secrets and ordinary chat", () => {
  const events = (text: string) => [
    { type: "text.started", runId: "r", payload: { textId: "u", role: "user" } },
    { type: "text.delta", runId: "r", payload: { textId: "u", delta: text } },
    { type: "text.started", runId: "r", payload: { textId: "a", role: "assistant" } },
    { type: "text.delta", runId: "r", payload: { textId: "a", delta: "Checked the headers." } },
    { type: "reasoning.delta", runId: "r", payload: { delta: "private reasoning" } },
  ] as AgentUXEvent[];
  assert.equal(learningEvidence(events("hello"), "r"), undefined);
  assert.doesNotMatch(learningEvidence(events("next time verify CSV"), "r")!, /private reasoning/);
  assert.equal(learningEvidence(events("next time password: dummy"), "r"), undefined);
});

test("RSL review is one tool-free bounded request; invalid proposals retain usage", async () => {
  let requests = 0;
  const provider = { protocol: "openai-compatible", baseUrl: "https://example.test/v1" } as PiProviderDefinition;
  const fetcher: typeof fetch = async (_url, options) => {
    requests++; const body = JSON.parse(String(options?.body));
    assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 500);
    return Response.json({ choices: [{ message: { content: "invalid" } }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
  };
  const result = await reviewLearning(provider, undefined, "unchanged-model", "excerpt", new AbortController().signal, fetcher);
  assert.equal(requests, 1); assert.equal(result.proposal, null); assert.equal(result.inputTokens, 20);
});

test("RSL daily budget resets at UTC boundary and deleted candidates stop reuse", async () => {
  const f = fixture(); let now = Date.parse("2026-10-29T23:59:00Z"), calls = 0;
  const service = createLearningService({ dataDir: f.dataDir, busy: () => false, now: () => now, delayMs: 1 });
  try {
    service.update({ action: "settings", revision: 0, enabled: true, reuse: true, dailyLimit: 1 });
    const review = async () => { calls++; return { proposal }; };
    service.enqueue({ ...source, review }); await until(() => service.state().candidates.length === 1);
    now += 120_000;
    service.enqueue({ ...source, runId: "next", review }); await until(() => calls === 2 && !service.state().running);
    assert.equal(service.state().calls, 1);
    const id = service.state().candidates[0].id;
    service.update({ action: "remove", revision: service.state().revision, id });
    assert.equal(service.state().candidates.length, 0);
  } finally { service.dispose(); f.cleanup(); }
});

test("RSL HTTP settings preserve origin checks, revisions and disabled default", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const f = fixture(); const host = createPiHttpHost({ cwd: f.dataDir, dataDir: f.dataDir, browser: false, routineClock: false });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/learning`;
  try {
    const initial = await (await fetch(url)).json(); assert.equal(initial.enabled, false);
    const action = { action: "settings", revision: initial.revision, enabled: true, reuse: false, dailyLimit: 2 };
    const post = (body: unknown, origin?: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(action, "https://foreign.example")).status, 403);
    assert.equal((await post(action)).status, 200);
    assert.equal((await post(action)).status, 409);
    const saved = await (await fetch(url)).json(); assert.equal(saved.enabled, true); assert.equal(saved.reuse, false);
    assert.equal((await post({ ...action, revision: saved.revision, dailyLimit: 0 })).status, 400);
  } finally { host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});

test("RSL waits for a full quiet period after a short foreground turn", async () => {
  const f = fixture(); let now = 0, calls = 0;
  const service = createLearningService({ dataDir: f.dataDir, busy: () => false, now: () => now, delayMs: 10 });
  try {
    service.update({ action: "settings", revision: 0, enabled: true, reuse: false, dailyLimit: 1 });
    service.enqueue({ ...source, review: async () => { calls++; return { proposal }; } });
    now = 5; service.interrupt(); now = 8; service.idle();
    now = 17; await pause(25); assert.equal(calls, 0);
    now = 18; await until(() => calls === 1 && !service.state().running);
  } finally { service.dispose(); f.cleanup(); }
});

test("RSL Chinese retrieval includes overlapping terms", async () => {
  const f = fixture();
  try {
    f.enable(); f.service.enqueue({ ...source, review: async () => ({ proposal: { title: "导出检查", trigger: "导出", lesson: "检查列名。" } }) });
    await until(() => f.service.state().candidates.length === 1);
    f.service.update({ action: "review", revision: f.service.state().revision, id: f.service.state().candidates[0].id, status: "approved" });
    f.service.update({ action: "settings", revision: f.service.state().revision, enabled: true, reuse: true, dailyLimit: 1 });
    assert.match(f.service.noteFor("bot", "pi", "请导出数据")!, /检查列名/);
  } finally { f.cleanup(); }
});
