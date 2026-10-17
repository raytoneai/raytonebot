// Same source, task and local model protocol for installed Pi SDK / Claude CLI / Codex app-server.
// No external requests or credentials. These results are native-engine evidence, not real-model/sandbox evidence.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntimeController } from "../src/pi/piHost.ts";
import { createMemoryService } from "../src/pi/memories.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "../src/pi/workspaceLayout.ts";

const root = mkdtempSync(join(tmpdir(), "rtb-engine-parity-"));
const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "work") }); ensureWorkspaceLayout(layout);
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
const dataDir = join(root, "data");
const memory = createMemoryService({ dataDir }); memory.add("parity-memory-sentinel");
const mcpSpec = { name: "mcp__fixture__read", description: "Read synthetic acceptance data", inputSchema: { type: "object", properties: {} } };
let mcpCalls = 0;
const mcpTools = () => ({ specs: [mcpSpec], servers: [{ id: "fixture", tools: [{ ...mcpSpec, name: "read" }] }], async run() { mcpCalls++; return { text: "parity-mcp-sentinel", isError: false }; } });
let operations = [], request = 0, turn = 0, role, requestError, sawMemory = false, sawContext = false;
const html = '<!doctype html><title>Parity file</title><h1>Acceptance sentinel</h1><button onclick="raytone.sendPrompt(\'parity-html-follow-up\')">Send follow-up</button>';
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url.includes("count_tokens")) { res.end('{"input_tokens":10}'); return; }
    if (body.stream === false) { res.end(JSON.stringify({ choices: [{ message: { content: "Parity task" } }], content: [{ type: "text", text: "Parity task" }] })); return; }
    const context = JSON.stringify(body.messages ?? body.input);
    if (turn === 1 && request === 0) sawMemory ||= context.includes("parity-memory-sentinel");
    if (turn === 2) sawContext ||= context.includes("PARITY_ORIGINAL_CONTEXT");
    const tools = (body.tools ?? []).map(t => t.function?.name ?? t.name);
    const op = tools.length ? operations[request++] : undefined;
    const name = op && (tools.find(n => n === op[0] || n === op[0].replace(/^mcp__/, "mcp_")) ?? tools.find(n => n.endsWith(`__${op[0]}`)));
    if (op) assert.ok(name, `Missing ${op[0]} in ${role} tools: ${tools.join(",")}`);
    const id = `call_${role}_${turn}_${request}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url.includes("/responses")) {
      const item = op ? { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(op[1]) }
        : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Parity complete", annotations: [] }] };
      const response = { id: `response_${id}`, object: "response", created_at: 1, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      for (const [type, fields] of [["response.created", { response: { ...response, status: "in_progress", output: [] } }], ["response.output_item.added", { output_index: 0, item }], ["response.output_item.done", { output_index: 0, item }], ["response.completed", { response }]]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    } else if (req.url.includes("/messages")) {
      const usage = { input_tokens: 10, output_tokens: 10 };
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      event("content_block_start", { index: 0, content_block: op ? { type: "tool_use", id, name, input: {} } : { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: op ? { type: "input_json_delta", partial_json: JSON.stringify(op[1]) } : { type: "text_delta", text: "Parity complete" } });
      event("content_block_stop", { index: 0 }); event("message_delta", { delta: { stop_reason: op ? "tool_use" : "end_turn", stop_sequence: null }, usage }); event("message_stop", {});
    } else {
      const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send(op ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(op[1]) } }] } : { role: "assistant", content: "Parity complete" }, null);
      send({}, op ? "tool_calls" : "stop"); res.write("data: [DONE]\n\n");
    }
    res.end();
  } catch (error) { requestError = error; res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const options = { cwd: layout.agents.assistant, dataDir, layout, sandboxed: false, memory, mcpTools };
let host = createPiRuntimeController(options);
try {
  for (role of ["assistant", "planner", "builder"]) {
    turn = 0; sawMemory = false; sawContext = false;
    const conversationId = `parity-${role}`, path = join(layout.shared, `${role}.html`), blocked = join(layout.shared, `${role}-blocked.html`);
    const config = { conversationId, provider: `parity-${role}`, model: "deepseek-flash", apiKey: "local-only", providerDefinition: { id: `parity-${role}`, name: "Loopback acceptance", protocol: role === "planner" ? "anthropic" : "openai-compatible", baseUrl: `http://127.0.0.1:${server.address().port}${role === "planner" ? "" : "/v1"}`, models: ["deepseek-flash"], authMode: "required" } };
    let approvals = 0;
    const writeOp = (target) => role === "planner" ? ["Write", { file_path: target, content: html }]
      : role === "builder" ? ["exec_command", { cmd: `printf '%s' '${html.replaceAll("'", "'\\''")}' > '${target}'`, yield_time_ms: 1000 }]
      : ["bash", { command: `printf '%s' '${html.replaceAll("'", "'\\''")}' > '${target}'` }];
    const run = async (prompt, stop = false) => {
      request = 0; turn++; requestError = undefined; await host.configure(config);
      const events = [];
      await host.runPrompt({ conversationId, agentPreset: role, prompt, provider: config.provider, model: config.model, permissionMode: "request" }, e => {
        events.push(e);
        if (e.type === "tool.call.awaiting_approval") {
          approvals++;
          if (stop) assert.equal(existsSync(blocked), false);
          setImmediate(() => stop ? void host.abort(conversationId) : host.resolveApproval(e.payload.toolCallId, "yes", conversationId));
        }
      }, { signal: AbortSignal.timeout(45_000) });
      assert.ifError(requestError);
      assert.equal(events.at(-1)?.type, "run.finished", JSON.stringify(events.filter(e => e.type === "run.error")));
      assert.equal(events.at(-1)?.payload.status, stop ? "cancelled" : "success");
      return events;
    };
    operations = [writeOp(path), ["mcp__fixture__read", {}], ["remember", { text: `parity-${role}-result` }], ["publish_artifact", { path }]];
    const created = await run("PARITY_ORIGINAL_CONTEXT: create shared HTML, read MCP, remember the result, register the actual file.");
    assert.equal(readFileSync(path, "utf8"), html); assert.ok(sawMemory, `${role} missed memory`);
    assert.ok(created.some(e => e.type === "artifact.finished" && String(e.payload.artifactId).startsWith("published_")));
    assert.ok(approvals >= 3, `${role} approvals=${approvals}`);
    const saved = JSON.parse(JSON.stringify(host.getConversation(conversationId))); host.dispose(); host = createPiRuntimeController(options);
    operations = [["publish_artifact", { path }]];
    await run("parity-html-follow-up: reopen and continue the original context");
    assert.ok(sawContext, `${role} lost native context on restart`);
    assert.equal(JSON.stringify(host.getConversation(conversationId).events.slice(0, saved.events.length)), JSON.stringify(saved.events));
    operations = [writeOp(blocked)]; await run("Stop before creating the next file", true);
    assert.equal(existsSync(blocked), false);
    console.log(JSON.stringify({ engine: role === "assistant" ? "Pi SDK" : role === "planner" ? "Claude CLI" : "Codex app-server", sameTask: true, approvals, file: true, registered: true, restart: true, memory: sawMemory, mcp: true, stoppedBeforeWrite: true }));
  }
  assert.equal(mcpCalls, 3);
} finally { host.dispose(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); }
