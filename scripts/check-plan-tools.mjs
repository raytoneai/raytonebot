// Actual Pi SDK + Claude CLI, with a loopback Anthropic endpoint. No external model request.
// Run: node scripts/check-plan-tools.mjs. Requires the installed `claude` CLI.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPiHttpHost } from "../src/pi/piHost.ts";
import { lastClaudeTaskPlan } from "../src/pi/claudeTaskPlan.ts";

if (process.env.RAYTONEBOT_SANDBOX === "1") throw new Error("Run this local check outside the production sandbox.");
const root = mkdtempSync("/tmp/raytone-plan-check-");
const cwd = join(root, "workspace");
mkdirSync(cwd);
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
let operations = [], request = 0, turn = 0, expectedTool, sawPriorContext = false;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url.includes("count_tokens")) { res.end('{"input_tokens":10}'); return; }
    assert.ok(body.tools.some((tool) => tool.name === expectedTool), `Missing native tool ${expectedTool}`);
    if (expectedTool === "update_plan") assert.match(JSON.stringify(body.system), /substantial multi-step work/);
    if (JSON.stringify(body.messages).includes("native task creation check")) sawPriorContext = true;
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
const snapshots = (events) => events.filter((event) => event.type === "artifact.delta" && event.payload.delta?.kind === "task-plan").map((event) => event.payload.delta);
const run = async (conversationId, agentPreset, prompt) => {
  request = 0;
  turn++;
  await host.controller.configure({ ...configuration, conversationId });
  const events = [];
  await host.controller.runPrompt({ conversationId, agentPreset, prompt, provider: configuration.provider,
    model: configuration.model, permissionMode: "request" }, (event) => events.push(event), { signal: AbortSignal.timeout(30_000) });
  assert.equal(events.at(-1)?.type, "run.finished", JSON.stringify(events.at(-1)));
  assert.equal(events.at(-1)?.payload.status, "success");
  return events;
};
try {
  await host.controller.configure(configuration);
  expectedTool = "update_plan";
  operations = ["in_progress", "completed"].map((status) => ["update_plan", { plan: [{ step: "Verify native Pi execution", status }] }]);
  const pi = snapshots(await run("plan-pi", "assistant", "native Pi plan check"));
  assert.deepEqual(pi.map((plan) => plan.steps[0].status), ["in_progress", "completed"]);
  console.log("PASS native Pi tool registration, execution, and persisted plan events");

  expectedTool = "TaskCreate";
  operations = [["TaskCreate", { subject: "读取需求", description: "Verify native task creation" }],
    ["TaskCreate", { subject: "检查结果", description: "Verify native task resume" }],
    ["TaskUpdate", { taskId: "1", status: "in_progress", addBlocks: ["2"] }],
    ["TaskUpdate", { taskId: "2", owner: "reviewer", addBlockedBy: ["1", "999"] }],
    ["TaskGet", { taskId: "2" }], ["TaskList", {}]];
  const created = snapshots(await run("plan-claude", "planner", "native task creation check"));
  assert.equal(created.at(-3).steps[1].dependenciesPending, true, "native silently ignores missing dependency ids");
  assert.equal(created.at(-2).steps[1].dependenciesPending, undefined, "TaskGet confirms actual dependencies");
  assert.equal(created.at(-2).steps[1].owner, "reviewer", "TaskGet must not clear its omitted owner");
  const saved = host.controller.getConversation("plan-claude");
  const sessionId = saved.cliSession.id;
  assert.deepEqual(lastClaudeTaskPlan(saved.events).map((step) => [step.taskId, step.status]), [["1", "in_progress"], ["2", "pending"]]);
  const nativeTaskPath = join(process.env.CLAUDE_CONFIG_DIR, "tasks", sessionId, "1.json");
  assert.equal(JSON.parse(readFileSync(nativeTaskPath, "utf8")).status, "in_progress");
  const second = lastClaudeTaskPlan(saved.events)[1];
  const nativeSecond = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "tasks", sessionId, "2.json"), "utf8"));
  assert.equal(second.owner, nativeSecond.owner);
  assert.deepEqual(second.blockedBy, nativeSecond.blockedBy);
  host.dispose();
  host = createPiHttpHost(options);
  await host.controller.configure(configuration);
  expectedTool = "TaskUpdate";
  sawPriorContext = false;
  operations = [["TaskUpdate", { taskId: "1", status: "completed" }], ["TaskGet", { taskId: "1" }],
    ["TaskUpdate", { taskId: "99", status: "completed" }], ["TaskUpdate", { taskId: "2", status: "deleted" }], ["TaskList", {}]];
  const resumed = await run("plan-claude", "planner", "native task resume check");
  assert.equal(host.controller.getConversation("plan-claude").cliSession.id, sessionId);
  assert.ok(sawPriorContext, "native CLI resume lost conversation context");
  assert.deepEqual(snapshots(resumed)[0].steps.map((step) => [step.taskId, step.status]), [["1", "completed"], ["2", "pending"]]);
  assert.equal(snapshots(resumed)[0].steps[1].owner, "reviewer");
  assert.deepEqual(snapshots(resumed)[0].steps[1].blockedBy, ["1"]);
  assert.deepEqual(snapshots(resumed).at(-1).steps, [{ taskId: "1", step: "读取需求", status: "completed" }]);
  assert.ok(resumed.some((event) => event.type === "tool.call.error" && JSON.stringify(event.payload).includes("Task not found")));
  assert.equal(JSON.parse(readFileSync(nativeTaskPath, "utf8")).status, "completed");
  console.log("PASS native Claude task identity, owners/dependencies, ignored ids, restart/resume, read/list/delete and failure feedback");
} finally {
  host.dispose();
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
