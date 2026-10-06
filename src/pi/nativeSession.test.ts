import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createPiRuntimeController } from "./piHost.ts";
import { openPiSession } from "./nativeSession.ts";

test("reset without environment credentials ignores the SDK placeholder and preserves a configured model", { timeout: 15_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "raytone-empty-model-reset-"));
  try {
    // A separate process and empty home keep ambient credentials from hiding the placeholder.
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createPiRuntimeController } from ${JSON.stringify(new URL("./piHost.ts", import.meta.url).href)};
      const root = process.argv[1];
      const host = createPiRuntimeController({ cwd: root, dataDir: root + '/data', sandboxed: false });
      try {
        const before = await host.state('unconfigured');
        assert.equal(before.provider, 'unknown');
        assert.equal(before.model, 'unknown');
        await host.newSession('unconfigured');
        await host.newSession('unconfigured');
        await host.configure({ conversationId: 'unconfigured', provider: 'reset-fixture', model: 'chosen-model', thinkingLevel: 'high',
          providerDefinition: { id: 'reset-fixture', name: 'Reset fixture', protocol: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1', models: ['chosen-model'], authMode: 'none' } });
        const configured = await host.state('unconfigured');
        const reset = await host.newSession('unconfigured');
        assert.equal(reset.provider, 'reset-fixture');
        assert.equal(reset.model, 'chosen-model');
        assert.equal(reset.thinkingLevel, configured.thinkingLevel);
        assert.notEqual(reset.sessionId, configured.sessionId);
      } finally { host.dispose(); }
    `, root], { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, timeout: 10_000, stdio: "pipe" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi resumes the exact native context, refuses missing history, and permits explicit recovery", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raytone-native-session-"));
  const cwd = join(root, "workspace"), dataDir = join(root, "data"), conversationId = "native-check";
  mkdirSync(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    // The host's one-off title request for a new conversation is not an engine turn.
    if (JSON.parse(body).stream === false) { res.end(JSON.stringify({ choices: [{ message: { content: "Native check" } }] })); return; }
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1,
      model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: "Native context retained." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config = { conversationId, provider: "native-check", model: "deepseek-flash", apiKey: "local-only",
    providerDefinition: { id: "native-check", name: "Local check", protocol: "openai-compatible" as const,
      baseUrl: `http://127.0.0.1:${port}/v1`, models: ["deepseek-flash"], authMode: "required" as const } };
  let host = createPiRuntimeController({ cwd, dataDir, sandboxed: false });
  const restart = () => { host.dispose(); host = createPiRuntimeController({ cwd, dataDir, sandboxed: false }); };
  const run = async (prompt: string, id = conversationId) => {
    const events: AgentUXEvent[] = [];
    await host.runPrompt({ conversationId: id, agentPreset: "assistant", prompt, provider: config.provider, model: config.model }, e => events.push(e));
    return events;
  };
  const nativeDir = join(dataDir, "pi-sessions", conversationId);
  const productFile = join(dataDir, "conversations", `${conversationId}.json`);
  try {
    await host.configure(config);
    assert.equal((await run("ORIGINAL_CONTEXT_SENTINEL")).at(-1)?.type, "run.finished");
    const original = host.getConversation(conversationId)!;
    const sessionId = (await host.state(conversationId)).sessionId;
    host.dispose();
    renameSync(nativeDir, `${nativeDir}.backup`);
    restart();
    await host.configure(config).catch(() => undefined);
    const missing = await run("Continue the original context");
    assert.equal(missing.at(-1)?.type, "run.error", "missing native history must not silently start a new context");
    assert.match(String(missing.at(-1)?.payload.message), /Restore.*native session.*start a new conversation/);
    assert.equal(requests.length, 1, "a refused resume must not reach the model");
    assert.deepEqual(host.getConversation(conversationId)?.events.slice(0, original.events.length), original.events);
    assert.equal(host.getConversation(conversationId)?.piSessionId, sessionId);

    // Restoring the original data permits a deliberate retry, with the old model context.
    renameSync(`${nativeDir}.backup`, nativeDir);
    await host.configure(config);
    assert.equal((await run("Now continue deliberately")).at(-1)?.type, "run.finished");
    assert.ok(requests.at(-1)?.includes("ORIGINAL_CONTEXT_SENTINEL"));
    assert.equal((await host.state(conversationId)).sessionId, sessionId);

    // Legacy transcripts have no binding: migrate only from a readable native session.
    host.dispose();
    const legacy = JSON.parse(readFileSync(productFile, "utf8"));
    delete legacy.piSessionId;
    writeFileSync(productFile, JSON.stringify(legacy));
    restart();
    await host.configure(config);
    assert.equal((await run("Migrate this legacy conversation")).at(-1)?.type, "run.finished");
    assert.equal(host.getConversation(conversationId)?.piSessionId, sessionId);
    assert.ok(requests.at(-1)?.includes("ORIGINAL_CONTEXT_SENTINEL"));

    // A truncated native JSONL must neither be overwritten nor resumed as a partial context.
    host.dispose();
    const nativeFile = join(nativeDir, readdirSync(nativeDir).find(name => name.endsWith(".jsonl"))!);
    writeFileSync(nativeFile, readFileSync(nativeFile, "utf8") + '{"broken":');
    const corrupt = readFileSync(nativeFile, "utf8"), count = requests.length;
    restart();
    await host.configure(config).catch(() => undefined);
    const broken = await run("Do not replace damaged native data");
    assert.match(String(broken.at(-1)?.payload.message), /Restore.*native session/);
    assert.equal(requests.length, count);
    assert.equal(readFileSync(nativeFile, "utf8"), corrupt);

    // Configuration errors before SDK acceptance are retryable without manufacturing a session.
    const fresh = "first-attempt";
    await assert.rejects(host.configure({ ...config, conversationId: fresh, apiKey: undefined, clearApiKey: true }), /No API key/);
    assert.equal((await run("Missing key", fresh)).at(-1)?.type, "run.error");
    assert.equal(host.getConversation(fresh)?.piSessionId, null);
    restart();
    await host.configure({ ...config, conversationId: fresh });
    assert.equal((await run("Configured now", fresh)).at(-1)?.type, "run.finished");
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1)?.includes("ORIGINAL_CONTEXT_SENTINEL"), false);

    // Explicit reset is allowed; it does not repair or replay the damaged original file.
    await host.newSession(conversationId);
    await host.configure(config);
    assert.equal((await run("Explicit new context")).at(-1)?.type, "run.finished");
    assert.notEqual((await host.state(conversationId)).sessionId, sessionId);
    assert.equal(requests.at(-1)?.includes("ORIGINAL_CONTEXT_SENTINEL"), false);
    assert.equal(readFileSync(nativeFile, "utf8"), corrupt);
    assert.equal(host.health().activeRuns, 0);

    // A binding that cannot be persisted must fail before a model request or tool side effect.
    const blocked = "binding-write-fails", beforeBinding = requests.length;
    await host.configure({ ...config, conversationId: blocked });
    const bindingEvents: AgentUXEvent[] = [];
    const tmp = join(dataDir, "conversations", `${blocked}.json.tmp`);
    await host.runPrompt({ conversationId: blocked, agentPreset: "assistant", prompt: "Do not run without a durable binding" }, e => {
      bindingEvents.push(e);
      if (e.type === "text.finished" && !bindingEvents.some(item => item.type === "run.error")) mkdirSync(tmp, { recursive: true });
    });
    assert.equal(requests.length, beforeBinding);
    assert.equal(bindingEvents.at(-1)?.payload.code, "history_save_failed");
    assert.equal(host.getConversation(blocked)?.piSessionId, null);
    rmSync(tmp, { recursive: true });
    assert.equal((await run("Explicit retry after repairing storage", blocked)).at(-1)?.type, "run.finished");
    assert.equal(requests.length, beforeBinding + 1);
  } finally {
    host.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native selection never substitutes a different or damaged session for the saved ID", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "raytone-native-selection-"));
  const input = { cwd: root, sessionDir: join(root, "sessions"), hasHistory: true };
  try {
    const first = pi.SessionManager.create(root, input.sessionDir);
    first.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
    const second = pi.SessionManager.create(root, input.sessionDir);
    second.appendMessage({ role: "user", content: [{ type: "text", text: "unrelated newer session" }], timestamp: Date.now() });
    const bound = { ...input, sessionId: first.getSessionId() };
    assert.equal((await openPiSession(pi, bound)).getSessionId(), first.getSessionId());
    rmSync(first.getSessionFile()!);
    await assert.rejects(openPiSession(pi, bound), /Restore.*native session/);
    assert.ok(readFileSync(second.getSessionFile()!, "utf8").includes("unrelated newer session"));
    writeFileSync(join(input.sessionDir, "damaged.jsonl"), "{broken");
    await assert.rejects(openPiSession(pi, input), /Restore.*native session/);
    rmSync(input.sessionDir, { recursive: true });
    await assert.rejects(openPiSession(pi, input), /Restore.*native session/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi refuses a branch with no native messages before binding an unusable child", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "raytone-native-branch-"));
  try {
    const sessionDir = join(root, "source"), childDir = join(root, "child");
    const source = pi.SessionManager.create(root, sessionDir);
    const setup = source.appendModelChange("deepseek", "deepseek-flash");
    const message = source.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
    const before = readFileSync(source.getSessionFile()!, "utf8");
    const input = { cwd: root, sessionDir: childDir, sessionId: null, hasHistory: true,
      branch: { sessionDir, sessionId: source.getSessionId(), entryId: setup } };
    await assert.rejects(openPiSession(pi, input), /Restore.*native session/);
    await assert.rejects(openPiSession(pi, { ...input, branch: { ...input.branch, entryId: "missing" } }), /Restore.*native session/);
    const child = await openPiSession(pi, { ...input, branch: { ...input.branch, entryId: message } });
    assert.notEqual(child.getSessionId(), source.getSessionId());
    assert.equal(readFileSync(source.getSessionFile()!, "utf8"), before);
    assert.equal((await openPiSession(pi, { ...input, branch: undefined, sessionId: child.getSessionId() })).getSessionId(), child.getSessionId());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
