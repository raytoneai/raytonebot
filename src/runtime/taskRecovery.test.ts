import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { taskRecovery, recoveryPrompt } from "./taskRecovery.ts";
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
  assert.equal(recoveryPrompt("Write a report", false, true), "Write a report");
  const prompt = recoveryPrompt("Write a report", true, true);
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
