import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexAppServer } from "./codexAppServer.ts";

type Json = Record<string, unknown>;

test("Codex user input is independent of permissions, validates thread, and returns native answer arrays", async () => {
  const sent: Json[] = [], requests: { signal: AbortSignal; resolve(value: Record<string, string[]> | null): void }[] = [];
  const abort = new AbortController();
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "question", signal: abort.signal, emit() {}, onSessionId() {},
    onPermission: async () => { assert.fail("questions must not request a permission grant"); },
    onUserInput: (request) => new Promise((resolve) => {
      assert.equal(request.questions[0].allowOther, true);
      requests.push({ signal: request.signal, resolve });
    }),
  });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "thread", result: { thread: { id: "thread" } } });
  const params = { threadId: "thread", itemId: "q", questions: [{ id: "language", header: "Language", question: "Which language?", isOther: true, isSecret: false, options: [{ label: "中文", description: "Chinese" }] }] };
  push({ id: 1, method: "item/tool/requestUserInput", params: { ...params, threadId: "wrong" } });
  assert.equal(requests.length, 0);
  assert.ok(sent.at(-1)?.error);
  push({ id: 2, method: "item/tool/requestUserInput", params });
  assert.equal(sent.some((value) => value.id === 2), false);
  requests[0].resolve({ language: ["中文"] });
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), { id: 2, result: { answers: { language: { answers: ["中文"] } } } });
  push({ id: 3, method: "item/tool/requestUserInput", params });
  requests[1].resolve(null);
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), { id: 3, result: { answers: {} } });
  push({ id: 4, method: "item/tool/requestUserInput", params });
  push({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 4 } });
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve({ language: ["中文"] });
  await Promise.resolve();
  assert.equal(sent.some((value) => value.id === 4), false);
  push({ id: 5, method: "item/tool/requestUserInput", params });
  abort.abort();
  requests[3].resolve({ language: ["中文"] });
  await Promise.resolve();
  assert.equal(sent.some((value) => value.id === 5), false);
});

test("Codex native protocol waits for each command/file decision, preserves resume and multi-file paths", async () => {
  const sent: Json[] = [];
  const events: Json[] = [];
  const sessions: string[] = [];
  const requests: { tool: { name: string; args: Json }; resolve(value: true | string): void }[] = [];
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "use attached file", resumeId: "old-thread", model: "deepseek-flash",
    signal: new AbortController().signal, emit: (e) => events.push(e), onSessionId: (id) => sessions.push(id),
    onPermission: (request) => new Promise((resolve) => { request.startExecution(); requests.push({ tool: request.tool, resolve }); }),
  });
  const push = (line: Json) => protocol.push(line, (line) => sent.push(line));
  push({ id: "initialize", result: {} });
  assert.equal(sent[1].method, "thread/resume");
  assert.deepEqual(sent[1].params, { threadId: "old-thread", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"], config: { tools: { update_plan: { enabled: true } }, features: { default_mode_request_user_input: true } }, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only", model: "deepseek-flash", modelProvider: "raytonebot" });
  push({ id: "thread", result: { thread: { id: "old-thread" } } });
  assert.deepEqual(sessions, ["old-thread"]);
  assert.equal((sent.at(-1)?.params as Json).threadId, "old-thread");
  assert.match(JSON.stringify(sent.at(-1)), /use attached file/);

  push({ id: 12, method: "item/commandExecution/requestApproval", params: { itemId: "cmd", command: "/bin/bash -lc 'echo hello > out.txt'", cwd: "/workspace/subdir" } });
  assert.equal(sent.some((x) => x.id === 12), false, "no approval response before gate resolves");
  assert.deepEqual(requests[0].tool.args, { command: "echo hello > out.txt", cwd: "/workspace/subdir" });
  requests[0].resolve(true);
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), { id: 12, result: { decision: "accept" } });

  push({ method: "item/started", params: { threadId: "old-thread", item: { type: "fileChange", id: "patch", status: "inProgress", changes: [
    { path: "a.txt", kind: { type: "add" }, diff: "+first" },
    { path: "../secret", kind: { type: "update", move_path: "/elsewhere/secret" }, diff: "+second" },
  ] } } });
  push({ id: 13, method: "item/fileChange/requestApproval", params: { itemId: "patch" } });
  assert.deepEqual(requests[1].tool.args.paths, ["/workspace/a.txt", "/secret", "/elsewhere/secret"]);
  requests[1].resolve("protected file denied");
  await Promise.resolve();
  assert.deepEqual(sent.at(-1), { id: 13, result: { decision: "decline" } });
  push({ method: "item/completed", params: { item: { id: "cmd", type: "commandExecution", command: "echo hello > out.txt", status: "completed", aggregatedOutput: "done", exitCode: 0 } } });
  assert.equal(events.filter((e) => e.type === "tool_execution_start" && e.toolCallId === "cmd").length, 1);
  assert.match(JSON.stringify(events.at(-1)), /done/);
  push({ method: "error", params: { error: { message: "recoverable context error" }, willRetry: false } });
  push({ method: "turn/completed", params: { turn: { status: "completed" } } });
  assert.equal(protocol.finished, true);
  assert.equal(protocol.failure, undefined);
});

test("Codex rejects unknown patch/permission grants and never replies accept after cancellation", async () => {
  const sent: Json[] = [];
  const run = new AbortController();
  let allow!: (value: true) => void;
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "x", signal: run.signal, emit() {}, onSessionId() {},
    onPermission: () => new Promise((resolve) => { allow = resolve; }),
  });
  const push = (line: Json) => protocol.push(line, (line) => sent.push(line));
  push({ id: 1, method: "item/fileChange/requestApproval", params: { itemId: "unknown" } });
  assert.deepEqual(sent.at(-1), { id: 1, result: { decision: "decline" } });
  push({ id: 2, method: "item/permissions/requestApproval", params: { permissions: { fileSystem: { write: ["/"] } } } });
  assert.ok(sent.at(-1)?.error, "bulk permission grants cannot bypass the tool gate");
  push({ id: 3, method: "item/commandExecution/requestApproval", params: { itemId: "cmd", command: "touch output" } });
  run.abort();
  allow(true);
  await Promise.resolve();
  assert.equal(sent.some((x) => x.id === 3), false);
});
