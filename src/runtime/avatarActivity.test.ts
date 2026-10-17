import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { avatarActivity, runOutcomeFace, workingGroupMember } from "./avatarActivity.ts";

const base = { running: false, awaitingUser: false, drafting: false, timeline: [] as AgentUXTimelineItem[] };
const tool = (status: string, name = "bash"): AgentUXTimelineItem => ({ kind: "tool", id: "t", name, status });
const answer = (text: string): AgentUXTimelineItem => ({ kind: "message", id: "m", role: "assistant", text });

test("the work indicator keeps the current group member through output and clears at turn boundaries", () => {
  const event = (type: string, payload: object = {}) => ({ type, runId: "r", payload }) as unknown as AgentUXEvent;
  const events = [event("run.started"), event("group.member.started", { member: "planner" }), event("text.delta", { delta: "Hello" })];
  assert.equal(workingGroupMember(events), "planner");
  assert.equal(workingGroupMember([...events, event("group.member.started", { member: "builder" }), event("tool.call.started")]), "builder");
  for (const terminal of ["run.finished", "run.error", "run.started"]) {
    assert.equal(workingGroupMember([...events, event(terminal)]), undefined);
  }
  assert.equal(workingGroupMember([event("group.member.started", { member: "unknown" })]), undefined);
  assert.equal(workingGroupMember([{ type: "group.member.started" } as unknown as AgentUXEvent]), undefined);
  assert.equal(workingGroupMember([]), undefined);
});

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

test("a lost connection outranks the run and the user's turn", () => {
  assert.equal(avatarActivity({ ...base, connectionLost: true, running: true, awaitingUser: true }), "fault");
  assert.equal(avatarActivity({ ...base, outcome: "fault" }), "fault");
});

test("a failed task and a failing engine end with different faces", () => {
  const event = (type: string, payload: object = {}) => ({ type, runId: "r", payload }) as unknown as AgentUXEvent;
  assert.equal(runOutcomeFace([event("run.finished")]), "success");
  assert.equal(runOutcomeFace([event("run.finished", { status: "failed" })]), "error");
  assert.equal(runOutcomeFace([event("run.finished", { status: "cancelled" })]), undefined);
  assert.equal(runOutcomeFace([event("run.finished"), event("run.error")]), "fault");
  assert.equal(runOutcomeFace([event("run.error"), event("run.finished"), event("text.delta")]), "success");
  assert.equal(runOutcomeFace([]), undefined);
});
