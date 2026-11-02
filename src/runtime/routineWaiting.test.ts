import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { routineWaiting } from "./routineWaiting.ts";

const event = (type: string, payload: Record<string, unknown>, runId = "current"): AgentUXEvent => ({
  protocol: "agent-ux", version: "0.1", id: "test", seq: 1, ts: 1, type, runId, payload,
});
const approval = (toolCallId: string, waitObservedAt?: number) => event("tool.call.awaiting_approval", { toolCallId, waitObservedAt });
const question = (requestId: string, waitObservedAt?: number, fields = {}) => event("run.awaiting_input", { requestId, toolCallId: `tool-${requestId}`, waitObservedAt, ...fields });

test("routine waits retain the oldest unresolved host time, count distinct waits, and resolve independently", () => {
  const events = [event("tool.call.awaiting_approval", { toolCallId: "old", waitObservedAt: 0 }, "prior"),
    approval("member~approval", 100), question("member~question", 200),
    question("vault", 300, { vaultRequest: {} }), question("channel", 400, { channelSetup: {} }),
    approval("member~approval", 500), question("member~question", 600)];
  assert.deepEqual(routineWaiting(events, "current"), { reasons: ["approval", "question", "vault", "channel_setup"], count: 4, since: 100 });
  events.push(event("tool.call.running", { toolCallId: "member~approval" }));
  events.push(event("tool.call.progress", { inputRequestId: "member~question" }));
  assert.deepEqual(routineWaiting(events, "current"), { reasons: ["vault", "channel_setup"], count: 2, since: 300 });
  events.push(event("tool.call.error", { toolCallId: "tool-vault" }));
  assert.deepEqual(routineWaiting(events, "current"), { reasons: ["channel_setup"], count: 1, since: 400 });
  events.push(event("tool.call.progress", { inputRequestId: "channel" }));
  assert.equal(routineWaiting(events, "current"), undefined);
});

test("legacy or invalid wait times remain unknown, and terminal runs never regain waiting state", () => {
  for (const time of [undefined, NaN, Infinity, -1]) {
    const events = [approval("known", 100), question("unknown", time)];
    assert.deepEqual(routineWaiting(events, "current"), { reasons: ["approval", "question"], count: 2 });
    events.push(question("unknown", 500));
    assert.equal(routineWaiting(events, "current")?.since, undefined, "a duplicate cannot invent a legacy start time");
    events.push(event("tool.call.progress", { inputRequestId: "unknown" }));
    assert.equal(routineWaiting(events, "current")?.since, 100);
  }
  for (const type of ["run.finished", "run.error"]) {
    assert.equal(routineWaiting([approval("a", 100), event(type, {}), approval("late", 200)], "current"), undefined);
  }
  for (const type of ["tool.call.running", "tool.call.result", "tool.call.error", "tool.call.finished"]) {
    assert.equal(routineWaiting([approval("a", 100), event(type, { toolCallId: "a" })], "current"), undefined);
  }
});
