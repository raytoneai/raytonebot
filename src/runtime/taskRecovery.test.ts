import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { taskRecovery, recoveryPrompt, interruptedRecoveryMessage } from "./taskRecovery.ts";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";

const event = (type: string, payload: object, runId = "r"): AgentUXEvent => ({ type, payload, runId, id: `${runId}:${type}`, ts: 1, seq: 1 }) as AgentUXEvent;
test("configuration failures offer the right destination only for the latest turn", () => {
  const events = [event("run.started", {}), event("run.error", { message: "DeepSeek API key is not set. Enter it in settings." })];
  assert.equal(taskRecovery(events)?.destination, "providers");
  assert.equal(taskRecovery([...events, event("run.started", {}, "next")]), undefined);
  assert.equal(taskRecovery([event("text.delta", { delta: "MCP server rejected the token" })]), undefined, "assistant prose is not a configuration failure");
  assert.equal(taskRecovery([event("tool.call.error", { toolCallId: "m", message: "The MCP server rejected the token." })])?.destination, "mcp");
  assert.equal(taskRecovery([event("tool.call.error", { toolCallId: "b", message: "Please log in to continue." })])?.destination, "browser");
  assert.equal(taskRecovery([event("run.error", { message: "Connection dropped; run status unknown." })]), undefined);
});

test("tool authentication failures keep their owning connection instead of opening model settings", () => {
  for (const [name, message, destination] of [
    ["mcp__github__list", "HTTP 401 Unauthorized", "mcp"],
    ["browser_read", "Unauthorized: login required", "browser"],
    ["mcp__raytone__browser_read", "HTTP 401 Unauthorized", "browser"],
    ["vault_use", "Missing saved login.", "vault"],
  ]) {
    const adapter = createPiEventAdapter({ runId: name });
    adapter.startUserMessage("Continue the task");
    adapter.apply({ type: "tool_execution_start", toolCallId: "call", toolName: name, args: {} });
    adapter.apply({ type: "tool_execution_end", toolCallId: "call", toolName: name, isError: true, result: { content: [{ type: "text", text: message }] } });
    adapter.finish();
    assert.equal(taskRecovery(adapter.events)?.destination, destination);
  }
});

test("continuing an accepted task asks to check progress; an unaccepted prompt is preserved exactly", () => {
  assert.equal(recoveryPrompt("Write a report", false, "zh"), "Write a report");
  const prompt = recoveryPrompt("Write a report", true, "zh");
  assert.match(prompt, /先核对/);
  assert.match(prompt, /不要重复/);
  assert.ok(prompt.endsWith("Write a report"));
});

test("a successful retry clears the resolved connection failure but leaves other failures actionable", () => {
  const adapter = createPiEventAdapter({ runId: "retry" });
  adapter.startUserMessage("Read the document");
  const call = (id: string, name: string, args: object, isError: boolean) => {
    adapter.apply({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
    adapter.apply({ type: "tool_execution_end", toolCallId: id, toolName: name, isError, result: { content: [{ type: "text", text: isError ? "HTTP 401 Unauthorized" : "Document contents" }] } });
  };
  call("first", "mcp__docs__read", { path: "report" }, true);
  assert.equal(taskRecovery([...adapter.events, event("run.finished", { status: "success" }, "retry")])?.destination, "mcp", "a completed reply can still need configuration");
  call("other", "mcp__other__read", { path: "report" }, false);
  assert.equal(taskRecovery(adapter.events)?.destination, "mcp", "another connection does not resolve this failure");
  call("other-file", "mcp__docs__read", { path: "other" }, false);
  assert.equal(taskRecovery(adapter.events)?.destination, "mcp", "a different operation does not prove this one recovered");
  call("retry", "mcp__docs__read", { path: "report" }, false);
  adapter.finish();
  assert.equal(taskRecovery(adapter.events), undefined);
});


test("only the latest host-restart cancellation offers explicit interrupted recovery", () => {
  const started = event("run.started", {});
  const restart = event("run.finished", { status: "cancelled", interruptionReason: "host_restart" });
  assert.equal(taskRecovery([started, restart])?.kind, "interrupted");
  assert.equal(taskRecovery([started, event("run.finished", { status: "cancelled" })]), undefined);
  assert.equal(taskRecovery([started, event("run.error", { message: "Transport failed" })]), undefined);
  for (const next of [event("run.started", {}, "new"), event("run.finished", { status: "success" }, "new")]) {
    assert.equal(taskRecovery([started, restart, next]), undefined);
  }
});

test("interrupted summary names only unfinished tools, excluding completed calls and private contents", () => {
  const adapter = createPiEventAdapter({ runId: "interrupted" });
  adapter.startUserMessage("Private original request");
  adapter.apply({ type: "tool_execution_start", toolCallId: "done", toolName: "write", args: { private: "hidden-args" } });
  adapter.apply({ type: "tool_execution_end", toolCallId: "done", toolName: "write", isError: false, result: { content: [{ type: "text", text: "hidden-result" }] } });
  adapter.apply({ type: "tool_execution_start", toolCallId: "pending", toolName: "mcp__publish", args: { private: "hidden-args" } });
  const recovery = taskRecovery([...adapter.events, event("tool.call.finished", { toolCallId: "pending", status: "cancelled" }, "interrupted"),
    event("run.finished", { status: "cancelled", interruptionReason: "host_restart" }, "interrupted")]);
  assert.equal(recovery?.kind, "interrupted");
  if (recovery?.kind !== "interrupted") return;
  assert.equal(recovery.unfinishedTool, "mcp__publish");
  for (const locale of ["en", "zh", "ja"] as const) {
    const message = interruptedRecoveryMessage(recovery, locale);
    assert.match(message, /mcp__publish/);
    assert.doesNotMatch(message, /hidden-|Private original|write/);
    const prompt = recoveryPrompt("Original task", true, locale, "interrupted");
    assert.ok(prompt.endsWith("Original task"));
    assert.doesNotMatch(prompt, /Configuration has been checked|配置已检查|設定を確認しました/);
  }
  assert.match(recoveryPrompt("Original task", true, "en", "interrupted"), /If an outcome cannot be verified, ask the user/);
  const completedOnly = taskRecovery([...adapter.events.filter(event => event.payload.toolCallId !== "pending"),
    event("run.finished", { status: "cancelled", interruptionReason: "host_restart" }, "interrupted")]);
  assert.equal(completedOnly?.kind === "interrupted" && completedOnly.unfinishedTool, undefined);
});
