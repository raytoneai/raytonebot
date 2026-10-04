// Real native engines, private data, loopback model protocols. No paid model request.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createPiRuntimeController } from "../src/pi/piHost.ts";

const root = mkdtempSync(join(tmpdir(), "raytone-branch-check-")), cwd = join(root, "workspace"), dataDir = join(root, "data");
mkdirSync(cwd); mkdirSync(join(root, "home"));
process.env.HOME = join(root, "home");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1";
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (req.url.includes("count_tokens")) { res.end('{"input_tokens":10}'); return; }
  requests.push(JSON.stringify(body.messages ?? body.input));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  if (req.url.endsWith("chat/completions")) {
    res.write(`data: ${JSON.stringify({ id: "pi", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "Context checked." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  } else if (req.url.includes("/messages")) {
    const usage = { input_tokens: 10, output_tokens: 5 };
    send("message_start", { message: { id: "msg_" + requests.length, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Context checked." } });
    send("content_block_stop", { index: 0 }); send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }); send("message_stop", {});
  } else {
    const item = { type: "message", id: "msg-" + requests.length, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Context checked.", annotations: [] }] };
    const response = { id: "response_" + requests.length, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    send("response.created", { response: { ...response, status: "in_progress", output: [] } });
    send("response.output_item.added", { output_index: 0, item }); send("response.output_item.done", { output_index: 0, item }); send("response.completed", { response });
  }
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let host = createPiRuntimeController({ cwd, dataDir, sandboxed: false });
const restart = () => { host.dispose(); host = createPiRuntimeController({ cwd, dataDir, sandboxed: false }); };
const nativeFile = (harness, id, conversationId) => {
  const dir = harness === "pi" ? join(dataDir, "pi-sessions", conversationId)
    : harness === "claude-code" ? join(root, "claude", "projects") : join(root, "home", ".codex", "sessions");
  const name = readdirSync(dir, { recursive: true }).find(name => name.endsWith(id + ".jsonl"));
  assert.ok(name, "Native session file was not found"); return join(dir, name);
};
try {
  for (const [agentPreset, harness] of [["assistant", "pi"], ["planner", "claude-code"], ["builder", "codex"]]) {
    const sourceId = "source-" + harness, provider = "branch-" + harness;
    const config = { provider, model: "deepseek-flash", apiKey: "local-only", providerDefinition: { id: provider, name: "Branch check", protocol: harness === "claude-code" ? "anthropic" : "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ["deepseek-flash"], authMode: "required" } };
    const configure = id => host.configure({ ...config, conversationId: id });
    const run = async (id, prompt, requestId) => {
      await configure(id); const events = [];
      await host.runPrompt({ conversationId: id, agentPreset, prompt, requestId, provider, model: config.model, permissionMode: "request" }, event => events.push(event));
      assert.equal(events.at(-1)?.type, "run.finished", JSON.stringify(events.at(-1)));
      assert.equal(events.at(-1)?.payload.status, "success");
    };
    await run(sourceId, "KEEP_BASE", "first"); await run(sourceId, "REMOVE_FUTURE", "second");
    const saved = host.getConversation(sourceId), originalId = harness === "pi" ? saved.piSessionId : saved.cliSession.id;
    assert.ok(saved.turns.every(turn => turn.native?.harness === harness), "Native per-turn checkpoints are missing");
    const file = nativeFile(harness, originalId, sourceId), nativeBefore = readFileSync(file, "utf8");
    const product = join(dataDir, "conversations", sourceId + ".json"), productBefore = readFileSync(product, "utf8");
    writeFileSync(join(cwd, "prior-effect.txt"), "Existing file effect stays");
    const branch = host.branchConversation(sourceId, "second"), childId = branch.conversation.id;
    assert.deepEqual(branch.draft, { prompt: "REMOVE_FUTURE", attachments: [] });
    assert.ok(branch.conversation.events.every(event => event.runId === "first"));
    await run(childId, "BRANCH_ONLY", "child");
    assert.ok(requests.at(-1).includes("KEEP_BASE") && requests.at(-1).includes("BRANCH_ONLY"));
    assert.ok(!requests.at(-1).includes("REMOVE_FUTURE"));
    assert.equal(readFileSync(file, "utf8"), nativeBefore); assert.equal(readFileSync(product, "utf8"), productBefore);
    assert.equal(readFileSync(join(cwd, "prior-effect.txt"), "utf8"), "Existing file effect stays");
    restart(); await run(childId, "CONTINUE_CHILD", "child-next");
    assert.ok(requests.at(-1).includes("KEEP_BASE") && requests.at(-1).includes("BRANCH_ONLY"));
    assert.ok(!requests.at(-1).includes("REMOVE_FUTURE"));
    assert.equal(readFileSync(file, "utf8"), nativeBefore, "Cold child resume changed the source native session");
    assert.equal(readFileSync(product, "utf8"), productBefore, "Cold child resume changed the source product record");
    await run(sourceId, "CONTINUE_SOURCE", "source-next");
    assert.ok(requests.at(-1).includes("REMOVE_FUTURE") && !requests.at(-1).includes("BRANCH_ONLY"));
    const fresh = host.branchConversation(sourceId, "first");
    await run(fresh.conversation.id, "EXPLICIT_FRESH", "fresh");
    assert.ok(!requests.at(-1).includes("KEEP_BASE"));
    console.log(`PASS ${harness}: native cutoff, original bytes, independent child resume, source resume, explicit fresh context.`);
  }
  assert.equal(host.health().activeRuns, 0);
  console.log(`PASS: ${requests.length} loopback model requests; no workspace rollback or implicit replay.`);
} finally {
  host.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
