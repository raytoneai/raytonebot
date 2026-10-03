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
