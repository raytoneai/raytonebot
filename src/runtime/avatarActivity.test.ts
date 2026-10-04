import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";
import { avatarActivity } from "./avatarActivity.ts";

const base = { running: false, awaitingUser: false, drafting: false, timeline: [] as AgentUXTimelineItem[] };
const tool = (status: string, name = "bash"): AgentUXTimelineItem => ({ kind: "tool", id: "t", name, status });
const answer = (text: string): AgentUXTimelineItem => ({ kind: "message", id: "m", role: "assistant", text });

test("a run shows what it is busy with", () => {
  assert.equal(avatarActivity({ ...base, running: true }), "thinking");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [{ kind: "reasoning", id: "r", status: "streaming" }] }), "thinking");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("running")] }), "working");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("running"), { kind: "step", id: "s", label: "x", status: "in_progress" }] }), "working");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("args_streaming", "edit")] }), "editing");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("running", "Write")] }), "editing");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("running", "read")] }), "reading");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("running", "grep")] }), "reading");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("done")] }), "thinking");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [tool("done"), answer("Hi")] }), "writing");
  assert.equal(avatarActivity({ ...base, running: true, timeline: [answer("")] }), "thinking");
});

test("the user's turn wins over the run, and a finished run shows its outcome", () => {
  assert.equal(avatarActivity({ ...base, running: true, awaitingUser: true, timeline: [tool("awaiting_approval")] }), "asking");
  assert.equal(avatarActivity({ ...base, outcome: "success", drafting: true }), "success");
  assert.equal(avatarActivity({ ...base, outcome: "error" }), "error");
  assert.equal(avatarActivity({ ...base, drafting: true }), "listening");
  assert.equal(avatarActivity(base), "idle");
});
