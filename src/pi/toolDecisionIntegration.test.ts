import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";

const nativeId = "same-native-call";
const readLog = (root: string) => readFileSync(join(root, "logs", "runtime.jsonl"), "utf8");
const decisions = (root: string) => readLog(root).trim().split("\n").map(line => JSON.parse(line)).filter(record => record.event === "tool.decision")
  .map(({ time: _time, event: _event, ...fields }) => fields);

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "controller did not reach the expected approval state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("controller tool decisions correlate concurrent native IDs and subsequent runs without logging arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-tool-decisions-"));
  const operation = new Map<string, "write" | "secret">();
  const factory: PiBridgeFactory = async ({ sessionDir, approvalGate }) => {
    const conversationId = decodeURIComponent(sessionDir!.split("/").pop()!);
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt() {
        const name = operation.get(conversationId) === "secret" ? "read" : "write";
        const args = { path: name === "read" ? "~/.ssh/PRIVATE-KEY" : "PRIVATE-PATH.md", content: "PRIVATE-ARGUMENT" };
        emit({ type: "tool_execution_start", toolCallId: nativeId, toolName: name, args });
        try {
          await approvalGate.wait(nativeId, name, args);
          emit({ type: "tool_execution_end", toolCallId: nativeId, toolName: name, result: { content: [{ type: "text", text: "Allowed" }] } });
        } catch (error) {
          emit({ type: "tool_execution_end", toolCallId: nativeId, toolName: name, isError: true, result: { content: [{ type: "text", text: String(error) }] } });
        }
      },
      async abort() {}, dispose() {}, async configure() {}, async newSession() {},
      async state() { return { models: [], tools: [] }; },
    };
  };
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), sandboxed: false, bridgeFactory: factory });
  const run = (conversationId: string, requestId: string, readOnly = false) => controller.runPrompt({ conversationId, requestId,
    prompt: "PRIVATE-PROMPT", permissionMode: "request" }, () => {}, { readOnly, signal: AbortSignal.timeout(5000) });
  try {
    const first = run("conversation-a", "run-a");
    const second = run("conversation-b", "run-b");
    await until(() => controller.hasApproval(nativeId, "conversation-a", "run-a") && controller.hasApproval(nativeId, "conversation-b", "run-b"));
    assert.equal(controller.resolveApproval(nativeId, "yes", "conversation-a", "run-a"), true);
    assert.equal(controller.resolveApproval(nativeId, "no", "conversation-b", "run-b"), true);
    assert.equal(controller.resolveApproval(nativeId, "yes", "conversation-b", "run-b"), false);
    await Promise.all([first, second]);
    operation.set("conversation-a", "secret");
    await run("conversation-a", "run-a-secret");
    await run("conversation-b", "run-b-readonly", true);
    operation.set("conversation-a", "write");
    const later = run("conversation-a", "run-a-later");
    await until(() => controller.hasApproval(nativeId, "conversation-a", "run-a-later"));
    assert.equal(controller.resolveApproval(nativeId, "yes", "conversation-a", "run-a"), false);
    assert.equal(controller.resolveApproval(nativeId, "yes", "conversation-a", "run-a-later"), true);
    await later;
    const records = decisions(root);
    const expected = (conversationId: string, runId: string, decision: string, extra = {}) => ({ conversationId, runId, toolCallId: nativeId, tool: "write", class: "mutating", decision, ...extra });
    assert.deepEqual(records.filter(record => record.conversationId === "conversation-a"), [
      expected("conversation-a", "run-a", "requested"), expected("conversation-a", "run-a", "approved"),
      expected("conversation-a", "run-a-secret", "refused", { tool: "read", class: "secret", reason: "secret" }),
      expected("conversation-a", "run-a-later", "requested"), expected("conversation-a", "run-a-later", "approved"),
    ]);
    assert.deepEqual(records.filter(record => record.conversationId === "conversation-b"), [
      expected("conversation-b", "run-b", "requested"), expected("conversation-b", "run-b", "denied"),
      expected("conversation-b", "run-b-readonly", "refused", { reason: "read_only" }),
    ]);
    assert.doesNotMatch(readLog(root), /PRIVATE|\.ssh|content|args|prompt/);
  } finally { await controller.abort(); controller.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("real controller Claude and Codex permission callbacks audit early policy refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-cli-tool-decisions-"));
  const executable = join(root, "controlled-cli");
  const savedClaude = process.env.RAYTONEBOT_CLAUDE_BIN, savedCodex = process.env.RAYTONEBOT_CODEX_BIN;
  writeFileSync(executable, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const codex = process.argv.includes('app-server');
let step = 0;
function attempt() {
  const id = 'native-' + step;
  if (codex) {
    const command = step === 0 ? 'cat ~/.ssh/PRIVATE-KEY' : 'touch PRIVATE-FILE';
    send({method:'item/started',params:{threadId:'native-session',item:{type:'commandExecution',id,command,cwd:process.cwd()}}});
    send({id:'permission-' + step,method:'item/commandExecution/requestApproval',params:{threadId:'native-session',itemId:id,command,cwd:process.cwd()}});
  } else send({type:'control_request',request_id:'permission-' + step,request:{subtype:'can_use_tool',tool_use_id:id,
    tool_name:step === 0 ? 'Read' : 'Bash',input:step === 0 ? {file_path:'~/.ssh/PRIVATE-KEY'} : {command:'touch PRIVATE-FILE'}}});
}
require('node:readline').createInterface({input:process.stdin}).on('line', raw => {
  const m = JSON.parse(raw);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start' || m.method === 'thread/resume') send({id:m.id,result:{thread:{id:'native-session'}}});
  if (m.method === 'turn/start') { send({id:m.id,result:{turn:{id:'native-turn'}}}); attempt(); }
  if (m.type === 'user') { send({type:'system',subtype:'init',session_id:'native-session'}); attempt(); }
  const permission = codex ? typeof m.id === 'string' && m.id.startsWith('permission-') : m.type === 'control_response' && m.response.request_id.startsWith('permission-');
  if (!permission) return;
  if (codex ? m.result.decision !== 'decline' : m.response.response.behavior !== 'deny') process.exit(9);
  if (++step < 2) { attempt(); return; }
  if (codex) send({method:'turn/completed',params:{threadId:'native-session',turn:{id:'native-turn',status:'completed'}}});
  else send({type:'result',subtype:'success',is_error:false,session_id:'native-session'});
});
`);
  chmodSync(executable, 0o700);
  process.env.RAYTONEBOT_CLAUDE_BIN = process.env.RAYTONEBOT_CODEX_BIN = executable;
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), sandboxed: false });
  try {
    for (const agentPreset of ["planner", "builder"] as const) {
      const events: { type: string; payload: Record<string, unknown> }[] = [];
      await controller.runPrompt({ conversationId: agentPreset, requestId: `${agentPreset}-run`, agentPreset,
        prompt: "PRIVATE-PROMPT", permissionMode: "allow-all", claudeCodeModelSource: "local-login", codexModelSource: "local-login" },
      event => events.push(event), { readOnly: true, signal: AbortSignal.timeout(5000) });
      assert.equal(events.at(-1)?.payload.status, "success", JSON.stringify(events.at(-1)));
      assert.deepEqual(decisions(root).filter(record => record.conversationId === agentPreset), [
        { conversationId: agentPreset, runId: `${agentPreset}-run`, toolCallId: "native-0", tool: agentPreset === "planner" ? "read" : "bash", class: "secret", decision: "refused", reason: "secret" },
        { conversationId: agentPreset, runId: `${agentPreset}-run`, toolCallId: "native-1", tool: "bash", class: "mutating", decision: "refused", reason: "read_only" },
      ]);
    }
    assert.doesNotMatch(readLog(root), /PRIVATE|\.ssh|args|prompt|command/);
  } finally {
    controller.dispose();
    if (savedClaude === undefined) delete process.env.RAYTONEBOT_CLAUDE_BIN; else process.env.RAYTONEBOT_CLAUDE_BIN = savedClaude;
    if (savedCodex === undefined) delete process.env.RAYTONEBOT_CODEX_BIN; else process.env.RAYTONEBOT_CODEX_BIN = savedCodex;
    rmSync(root, { recursive: true, force: true });
  }
});
