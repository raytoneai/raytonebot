// Actual Codex app-server + loopback Responses endpoint. No external model request.
// Run: node scripts/check-codex-user-input.mjs (requires the installed `codex` CLI).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCodex } from "../src/pi/cliHarness.ts";

if (process.env.RAYTONEBOT_SANDBOX === "1") throw new Error("Run this local fake-provider check outside the production sandbox.");
const root = mkdtempSync("/tmp/raytone-codex-check-");
const cwd = join(root, "workspace");
mkdirSync(cwd);
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
let sawQuestion = false, receivedAnswer = false;
let request = 0;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(body.tools.some((tool) => tool.name === "request_user_input"));
    const outputs = body.input.filter((item) => item.type === "function_call_output");
    if (outputs.length) { assert.deepEqual(JSON.parse(outputs.at(-1).output), { answers: { language: { answers: ["中文"] } } }); receivedAnswer = true; }
    const stage = request++;
    const item = stage === 0 ? { type: "function_call", id:"fc_question", call_id:"question_call", name:"request_user_input", arguments:JSON.stringify({questions:[{id:"language",header:"Language",question:"Which language?",options:[{label:"中文",description:"Chinese"},{label:"English",description:"English"}]}]}) } : {type:"message",id:"done",role:"assistant",status:"completed",content:[{type:"output_text",text:"Done",annotations:[]}]};
    const response = { id: `response_${request}`, object: "response", created_at: 1, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, fields] of [
      ["response.created", { response: { ...response, status: "in_progress", output: [] } }],
      ["response.output_item.added", { output_index: 0, item }],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response }],
    ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await runCodex({cwd,prompt:"question check",permissionMode:"allow-all",provider:{name:"check",baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:"local-only",model:"deepseek-flash"},signal:AbortSignal.timeout(30000),emit(){},onSessionId(){},onPermission:async()=>{throw Error("not a permission")},onUserInput:async request=>{sawQuestion=true;assert.equal(request.questions[0].question,"Which language?");return {language:["中文"]}}});
  assert.ok(sawQuestion && receivedAnswer, "native default mode did not complete the question round-trip");
  console.log("PASS native Codex default-mode question → actual answer → model tool result");
} finally {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
