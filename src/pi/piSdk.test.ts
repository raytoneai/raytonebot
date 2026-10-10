import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createPiRuntimeController } from "./piHost.ts";

// Exercise the installed SDK and real tools through the model protocol, without a paid request.
test("installed Pi SDK preserves guarded tools, approval effects, cancellation and native session resume", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raytone-pi-sdk-"));
  const cwd = join(root, "workspace"), file = join(cwd, "check.txt");
  mkdirSync(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const names = ["ask_user", "bash", "edit", "find", "grep", "ls", "read", "update_plan", "web_fetch", "web_search", "write"];
  let operations: [string, Record<string, unknown>][] = [], request = 0, turn = 0;
  let requestError: unknown, resumedContext = false, failStoreOnCompletion = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // The host's one-off title request for a new conversation is not an engine turn.
      if (body.stream === false) { res.end(JSON.stringify({ choices: [{ message: { content: "SDK check" } }] })); return; }
      assert.equal(body.model, "deepseek-flash");
      assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), names);
      if (turn === 3) resumedContext = JSON.stringify(body.messages).includes("SDK original context sentinel");
      const op = operations[request++];
      if (failStoreOnCompletion && !op) mkdirSync(join(root, "data", "conversations", "sdk-check.json.tmp"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
        id: `sdk-${turn}-${request}`, object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      send(op ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${turn}-${request}`, type: "function",
        function: { name: op[0], arguments: JSON.stringify(op[1]) } }] } : { role: "assistant", content: "SDK check complete." }, null);
      send({}, op ? "tool_calls" : "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { requestError = error; res.writeHead(500); res.end("Local SDK check failed"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const configuration = { provider: "sdk-check", model: "deepseek-flash", apiKey: "local-only",
    providerDefinition: { id: "sdk-check", name: "SDK check", protocol: "openai-compatible" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["deepseek-flash"], authMode: "required" as const } };
  const options = { cwd, dataDir: join(root, "data"), appRoot: process.cwd(), sandboxed: false };
  let host = createPiRuntimeController(options);
  const conversationId = "sdk-check";
  const beforeApproval: string[] = [];
  let approvals = 0;
  const run = async (decision: "yes" | "no" | "stop", prompt: string) => {
    request = 0; turn++;
    await host.configure({ ...configuration, conversationId });
    const events: AgentUXEvent[] = [];
    await host.runPrompt({ conversationId, prompt, provider: configuration.provider, model: configuration.model,
      permissionMode: "request", agentPreset: "assistant" }, (event) => {
      events.push(event);
      if (event.type !== "tool.call.awaiting_approval") return;
      approvals++;
      if (turn === 1) beforeApproval.push(existsSync(file) ? readFileSync(file, "utf8") : "");
      else assert.equal(existsSync(join(cwd, "blocked.txt")), false, "write happened before approval");
      setImmediate(() => decision === "stop" ? void host.abort(conversationId)
        : host.resolveApproval(event.payload.toolCallId as string, decision, conversationId));
    }, { signal: AbortSignal.timeout(20_000) });
    assert.ifError(requestError);
    return events;
  };
  try {
    operations = [
      ["write", { path: "check.txt", content: "before\n" }], ["read", { path: "check.txt" }],
      ["edit", { path: "check.txt", edits: [{ oldText: "before", newText: "after" }] }],
      ["grep", { path: ".", pattern: "after" }], ["find", { path: ".", pattern: "*.txt" }],
      ["ls", { path: "." }], ["bash", { command: "printf sdk-shell-ok" }],
      ["update_plan", { plan: [{ step: "Check SDK compatibility", status: "completed" }] }],
    ];
    const first = await run("yes", "SDK original context sentinel");
    assert.equal(approvals, 3);
    assert.deepEqual(beforeApproval, ["", "before\n", "after\n"]);
    assert.equal(readFileSync(file, "utf8"), "after\n");
    assert.equal(first.filter((event) => event.type === "tool.call.result").length, 8, JSON.stringify(first.filter((event) => event.type === "tool.call.error")));
    assert.equal(first.at(-1)?.type, "run.finished");
    assert.equal(first.at(-1)?.payload.status, "success");
    assert.match(JSON.stringify(first), /sdk-shell-ok/);
    const sessionId = (await host.state(conversationId)).sessionId;

    operations = [["write", { path: "blocked.txt", content: "must not exist" }]];
    const denied = await run("no", "Reject this write");
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
    assert.ok(denied.some((event) => event.type === "tool.call.error"));
    host.dispose();
    host = createPiRuntimeController(options);
    operations = [["read", { path: "check.txt" }]];
    const resumed = await run("yes", "Resume the earlier context");
    assert.equal((await host.state(conversationId)).sessionId, sessionId);
    assert.ok(resumedContext, "native session lost the earlier model context");
    assert.match(JSON.stringify(resumed), /after/);

    operations = [["edit", { path: "check.txt", edits: [{ oldText: "missing sentinel", newText: "replacement" }] }]];
    const failed = await run("yes", "Report an ordinary edit failure");
    assert.ok(failed.some((event) => event.type === "tool.call.error"));
    assert.equal(failed.find((event) => event.type === "tool.call.finished")?.payload.status, "error");
    assert.equal(readFileSync(file, "utf8"), "after\n");

    operations = [["write", { path: "blocked.txt", content: "must not exist" }]];
    const stopped = await run("stop", "Stop during approval");
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
    assert.equal(stopped.filter((event) => ["run.finished", "run.error"].includes(event.type)).length, 1);
    assert.equal(stopped.at(-1)?.payload.status, "cancelled");
    assert.equal(stopped.find((event) => event.type === "tool.call.finished")?.payload.status, "cancelled");
    assert.equal(stopped.some((event) => event.type === "tool.call.error"), false, "a requested stop is not a tool failure");

    operations = [["write", { path: "completed-before-save-failure.txt", content: "actual SDK side effect" }]];
    failStoreOnCompletion = true;
    const saveFailed = await run("yes", "Complete a real write, then report the storage failure honestly");
    assert.equal(readFileSync(join(cwd, "completed-before-save-failure.txt"), "utf8"), "actual SDK side effect");
    assert.equal(saveFailed.filter((event) => ["run.finished", "run.error"].includes(event.type)).length, 1);
    assert.equal(saveFailed.at(-1)?.payload.code, "history_save_failed");
    assert.equal(host.health().activeRuns, 0);
    assert.equal(host.getConversation(conversationId)?.incomplete, true);
  } finally {
    host.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
