// Native Codex + a local fake Responses endpoint. No model account or paid request is used.
// Run: node scripts/check-codex-approvals.mjs (requires the installed `codex` CLI).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCodex } from "../src/pi/cliHarness.ts";

if (process.env.RAYTONEBOT_SANDBOX === "1") throw new Error("Run this local fake-provider check outside the production sandbox.");
const root = mkdtempSync("/tmp/raytone-codex-check-");
const cwd = join(root, "workspace");
mkdirSync(cwd);
const shared = join(root, "shared");
mkdirSync(shared);
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME);
for (const home of [process.env.HOME, cwd]) {
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "deliberately invalid TOML [");
}
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
let current;
let request = 0;
let sawPreviousPrompt = false;
let session;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.match(JSON.stringify(body.tools), /"update_plan"/, "native plan tool was not enabled");
    if (session && JSON.stringify(body.input).includes("native approval check: shell-allow")) sawPreviousPrompt = true;
    const stage = request++;
    const item = stage === 0 || stage === 2
      ? { type: "function_call", id: `fc_plan_${stage}`, call_id: `plan_call_${stage}`, name: "update_plan",
        arguments: JSON.stringify({ plan: [{ step: "Check approval", status: stage === 0 ? "in_progress" : "completed" }] }) }
      : stage === 1
      ? { type: "function_call", id: "fc_check", call_id: "check_call", name: "exec_command",
        arguments: JSON.stringify({ cmd: current.command, yield_time_ms: 1000 }) }
      : { type: "message", id: "msg_check", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Finished the approval check.", annotations: [] }] };
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
  for (const kind of ["shell", "patch"]) for (const allow of [true, false]) {
    const name = `${kind}-${allow ? "allow" : "deny"}`;
    const filename = `${name}.txt`;
    const path = kind === "patch" ? join(shared, filename) : join(cwd, filename);
    current = { command: kind === "shell" ? `printf checked > ${filename}`
      : `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${path}\n+checked\n*** End Patch\nPATCH` };
    request = 0;
    let approvals = 0;
    const events = [];
    const run = new AbortController();
    const timeout = setTimeout(() => run.abort(), 30_000);
    try {
      const previous = session;
      await runCodex({ cwd, addDirs: [shared], prompt: `native approval check: ${name}`, permissionMode: "request", resumeId: previous,
        provider: { name: "local approval check", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fake-local-only", model: "deepseek-flash" },
        signal: run.signal, emit: (event) => events.push(event), onSessionId: (id) => { session = id; },
        onPermission: async ({ tool, startExecution }) => {
          approvals++;
          assert.equal(tool.name, kind === "shell" ? "bash" : "edit");
          assert.equal(existsSync(path), false, "effect occurred before approval");
          startExecution();
          return allow ? true : "User declined this operation.";
        },
      });
      assert.equal(run.signal.aborted, false, "native protocol timed out");
      assert.equal(approvals, 1);
      assert.equal(existsSync(path), allow);
      if (allow) assert.equal(readFileSync(path, "utf8").trim(), "checked");
      assert.equal(events.find((event) => event.type === "tool_execution_end")?.isError, !allow);
      const plans = events.filter((event) => event.type === "plan_update");
      assert.equal(plans.length, 2, "native plan notifications were lost");
      assert.equal(plans[0].plan[0].status, "inProgress");
      assert.equal(plans[1].plan[0].status, "completed");
      if (previous) assert.equal(session, previous, "resume started a different native session");
      console.log(`PASS ${name}`);
    } finally { clearTimeout(timeout); }
  }
  assert.ok(sawPreviousPrompt, "native resume lost the prior turn context");
  console.log("PASS native session resume across isolated homes");
  console.log("PASS user/project config isolation");
} finally {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
