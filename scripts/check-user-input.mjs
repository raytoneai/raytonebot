// Actual Pi SDK + Claude CLI questions against a loopback model endpoint.
// Run: node scripts/check-user-input.mjs. No external model/account request.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPiHttpHost } from "../src/pi/piHost.ts";
import { pendingUserInput } from "../src/runtime/userInput.ts";

if (process.env.RAYTONEBOT_SANDBOX === "1") throw new Error("Run this local check outside the production sandbox.");
const root = mkdtempSync("/tmp/raytone-plan-check-");
const cwd = join(root, "workspace");
mkdirSync(cwd);
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
let operations = [], request = 0, turn = 0, expectedTool, toolResults = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url.includes("count_tokens")) { res.end('{"input_tokens":10}'); return; }
    assert.ok(body.tools.some((tool) => tool.name === expectedTool), `Missing native tool ${expectedTool}`);
    toolResults = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
    const op = operations[request++];
    const block = op ? { type: "tool_use", id: `tool_${turn}_${request}`, name: op[0], input: op[1] }
      : { type: "text", text: "Native plan check finished." };
    const usage = { input_tokens: 10, output_tokens: 10 };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_${turn}_${request}`, type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, stop_sequence: null, usage } });
    event("content_block_start", { index: 0, content_block: op ? { ...block, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: op ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: op ? "tool_use" : "end_turn", stop_sequence: null }, usage });
    event("message_stop", {});
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const configuration = { provider: "local-plan-check", model: "deepseek-flash", apiKey: "local-only",
  providerDefinition: { id: "local-plan-check", name: "Local plan check", protocol: "anthropic",
    baseUrl: `http://127.0.0.1:${server.address().port}`, models: ["deepseek-flash"], authMode: "required" } };
const options = { cwd, dataDir: join(root, "data"), appRoot: process.cwd() };
let host = createPiHttpHost(options);

const http = createServer((req, res) => void host.handle(req, res));
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const answer = (conversationId, requestId, answers) => fetch(`http://127.0.0.1:${http.address().port}/__agentcanvas/pi/input`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, requestId, answers }),
});
const questions = [
  { question: "报告需要哪种语言？", header: "语言", options: [{ label: "中文", description: "用中文回复" }, { label: "English", description: "Reply in English" }], multiSelect: false },
  { question: "要检查哪些内容？", header: "范围", options: [{ label: "代码", description: "检查实现" }, { label: "交互", description: "检查界面" }], multiSelect: true },
];
try {
  await host.controller.configure(configuration);
  for (const agentPreset of ["assistant", "planner"]) for (const mode of ["answer", "skip", "stop"]) {
    request = 0; turn++; toolResults = [];
    expectedTool = agentPreset === "planner" ? "AskUserQuestion" : "ask_user";
    operations = [[expectedTool, { questions }]];
    const conversationId = `${agentPreset}-${mode}`, events = [];
    await host.controller.configure({ ...configuration, conversationId });
    let announce;
    const announced = new Promise((resolve) => { announce = resolve; });
    const running = host.controller.runPrompt({ conversationId, agentPreset, prompt: "native question check",
      provider: configuration.provider, model: configuration.model, permissionMode: "allow-all" }, (event) => {
        events.push(event);
        if (event.type === "run.awaiting_input") announce(event.payload);
      }, { signal: AbortSignal.timeout(20_000) });
    const question = await Promise.race([announced, running.then(() => { throw new Error("Run finished without waiting for input: " + JSON.stringify(events.at(-1))); })]);
    assert.ok(pendingUserInput(host.controller.getConversation(conversationId).events));
    assert.equal(events.some((e) => e.type === "tool.call.awaiting_approval"), false);
    assert.equal((await answer("wrong", question.requestId, null)).status, 409);
    assert.equal((await answer(conversationId, question.requestId, {})).status, 400);
    if (mode === "stop") {
      await host.controller.abort(conversationId);
      await running;
      assert.equal(events.at(-1).payload.status, "cancelled");
      assert.equal((await answer(conversationId, question.requestId, null)).status, 409);
    } else {
      const response = mode === "skip" ? null : { q0: ["中文"], q1: ["代码", "交互", "保留现有组件"] };
      assert.equal((await answer(conversationId, question.requestId, response)).status, 200);
      assert.equal((await answer(conversationId, question.requestId, response)).status, 200);
      assert.equal((await answer(conversationId, question.requestId, mode === "skip" ? { q0: ["English"], q1: ["代码"] } : null)).status, 409);
      await running;
      assert.equal(events.at(-1).payload.status, "success", JSON.stringify(events.at(-1)));
      assert.match(JSON.stringify(toolResults), mode === "skip" ? /skipped|did not answer/ : /中文/);
      if (mode === "answer") assert.match(JSON.stringify(toolResults), /保留现有组件/);
    }
    assert.equal(pendingUserInput(events), undefined);
    assert.equal(pendingUserInput(host.controller.getConversation(conversationId).events), undefined);
    console.log(`PASS native ${expectedTool}: ${mode}, saved waiting state, HTTP validation and duplicate handling`);
  }
} finally {
  host.dispose();
  http.closeAllConnections();
  http.close();
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
