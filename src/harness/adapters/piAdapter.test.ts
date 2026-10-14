import assert from "node:assert/strict";
import { test } from "node:test";

import { createPiEventAdapter } from "./piAdapter.ts";

const assistant = (stopReason: string, errorMessage?: string) => ({
  type: "message_end",
  message: { role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}) },
});

/** Pi's order when a model request fails and its automatic retry succeeds. */
test("a failed request that Pi retries successfully ends the run as success", () => {
  const events: { type: string; payload?: { status?: string } }[] = [];
  const adapter = createPiEventAdapter({ runId: "r", onEvent: (event) => events.push(event as never) });
  for (const event of [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant" } },
    assistant("error", "overloaded"),
    { type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } },
    assistant("stop"),
    { type: "auto_retry_end", attempt: 1, success: true },
    { type: "agent_settled" },
  ]) adapter.apply(event);
  adapter.finish("success");
  assert.equal(events.some((event) => event.type === "run.error"), false);
  assert.deepEqual(events.filter((event) => event.type === "run.finished").map((event) => event.payload?.status), ["success"]);
});

test("a failed request without a successful retry still ends the run as an error", () => {
  const events: { type: string }[] = [];
  const adapter = createPiEventAdapter({ runId: "r", onEvent: (event) => events.push(event as never) });
  adapter.apply({ type: "agent_start" });
  adapter.apply({ type: "message_start", message: { role: "assistant" } });
  adapter.apply(assistant("error", "bad key"));
  adapter.apply({ type: "agent_settled" });
  adapter.finish("success");
  assert.equal(events.filter((event) => event.type === "run.error").length, 1);
});

test("overflow compaction clears the failed request only after a successful response", () => {
  for (const recovered of [true, false]) {
    const adapter = createPiEventAdapter({ runId: "overflow" });
    adapter.apply({ type: "agent_start" });
    adapter.apply(assistant("error", "context length exceeded"));
    adapter.apply({ type: "compaction_start", reason: "overflow" });
    adapter.apply({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });
    if (recovered) {
      adapter.apply({ type: "message_start", message: { role: "assistant" } });
      adapter.apply(assistant("stop"));
    }
    const terminal = adapter.apply({ type: "agent_settled" });
    assert.equal(terminal.at(-1)?.type, recovered ? "run.finished" : "run.error");
    assert.deepEqual(adapter.finish("success"), [], "terminal is emitted once");
  }
});

test("a Codex file_change becomes the same file artifacts as Pi's write and edit", async () => {
  const { createAgentUXViewModel } = await import("@agent-ux/render-core");
  const { createCodexAppServer } = await import("../../pi/codexAppServer.ts");
  const adapter = createPiEventAdapter({ runId: "r" });
  const protocol = createCodexAppServer({ cwd: "/w", prompt: "x", signal: new AbortController().signal,
    emit: adapter.apply, onSessionId() {}, onPermission: async () => true });
  const push = (line: Record<string, unknown>) => protocol.push(line, () => {});
  push({ id: "thread", result: { thread: { id: "main" } } });
  const item = (id: string, changes: unknown[]) => ({ id, type: "fileChange", status: "completed", changes });
  for (const [id, changes] of [
    ["add", [{ path: "page.html", kind: { type: "add" }, diff: "<h1>x</h1>\n" }]],
    ["patch", [{ path: "app.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }, { path: "old.html", kind: { type: "delete" }, diff: "" },
      { path: "a.htm", kind: { type: "update", move_path: "b.html" }, diff: "@@ -1 +1 @@\n-c\n+d\n" }]],
  ] as const) {
    push({ method: "item/started", params: { threadId: "main", item: item(id, [...changes]) } });
    push({ method: "item/completed", params: { threadId: "main", item: item(id, [...changes]) } });
  }
  const artifacts = createAgentUXViewModel(JSON.parse(JSON.stringify(adapter.events))).timeline
    .filter((entry) => entry.kind === "artifact") as { title?: string; artifactKind?: string; uri?: string; content?: string }[];
  assert.deepEqual(artifacts.map((artifact) => [artifact.title, artifact.artifactKind, artifact.uri]), [
    ["/w/page.html", "code", "file:///w/page.html"],
    ["/w/app.ts", "diff", "file:///w/app.ts"],
    ["/w/b.html", "diff", "file:///w/b.html"],
  ]);
  assert.match(artifacts[0].content ?? "", /<h1>x<\/h1>/);
});
