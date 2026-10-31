import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createEphemeralPiConversation } from "../pi/piConversationState.ts";
import { createConversationStream } from "./conversationStream.ts";

let eventId = 0;
const event = (type: string, runId = "run", payload: Record<string, unknown> = {}): AgentUXEvent =>
  ({ id: `${type}-${++eventId}`, runId, type, payload } as AgentUXEvent);

function withFrames(run: (flushFrames: () => void) => void) {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id); }) as typeof cancelAnimationFrame;
  const flushFrames = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(Date.now());
    }
  };
  try { run(flushFrames); } finally {
    flushFrames();
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
}

function conversation() {
  return createEphemeralPiConversation("conversation");
}

test("replace cancels a queued frame before committing the authoritative snapshot", () => {
  withFrames((flushFrames) => {
    const applied: string[][] = [];
    let owner = true;
    const stream = createConversationStream(conversation(), {
      isCurrent: () => owner,
      commit: value => applied.push(value.events.map(event => event.type)),
    });
    stream.append(event("text.delta"));
    stream.replace({ ...conversation(), events: [event("run.started")] });
    flushFrames();
    assert.deepEqual(applied, [["run.started"]]);
  });
});

test("cancel drops a queued frame before it can land", () => {
  withFrames((flushFrames) => {
    const applied: string[][] = [];
    const stream = createConversationStream(conversation(), {
      isCurrent: () => true,
      commit: value => applied.push(value.events.map(event => event.type)),
    });
    stream.append(event("text.delta"));
    stream.cancel();
    flushFrames();
    assert.deepEqual(applied, []);
  });
});

test("unmount-style ownership invalidation prevents stale queued frames from landing", () => {
  withFrames((flushFrames) => {
    const applied: string[][] = [];
    let owner = true;
    const stream = createConversationStream(conversation(), {
      isCurrent: () => owner,
      commit: value => applied.push(value.events.map(event => event.type)),
    });
    stream.append(event("text.delta"));
    owner = false;
    stream.flush();
    flushFrames();
    assert.deepEqual(applied, []);
  });
});

test("waits flush immediately, preserve sibling approvals, and keep canonical seq plus group metadata", () => {
  withFrames((flushFrames) => {
    const applied: AgentUXEvent[][] = [];
    const waiting: boolean[] = [];
    const stream = createConversationStream(conversation(), {
      isCurrent: () => true,
      commit: value => applied.push([...value.events]),
      onAwaiting: value => waiting.push(value),
    });
    stream.append(event("run.started"));
    stream.append(event("tool.call.awaiting_approval", "run", { toolCallId: "one" }));
    stream.append(event("tool.call.awaiting_approval", "run", { toolCallId: "two" }));
    stream.append(event("tool.call.running", "run", { toolCallId: "one" }));
    stream.append(event("run.awaiting_input", "run", { requestId: "channel" }));
    stream.append(event("run.awaiting_input", "run", { requestId: "channel", stage: "next" }));
    stream.append(event("group.members.updated", "run", { group: { members: ["assistant", "planner"], hostId: "assistant" } }));
    assert.deepEqual(waiting, [false, true, true, true, true, true]);
    assert.equal(applied.at(-1)?.at(-1)?.type, "run.awaiting_input", "same-request channel stages flush immediately");
    stream.flush();
    assert.deepEqual(stream.current.events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(stream.current.groupMembers, ["assistant", "planner"]);
    stream.append(event("tool.call.finished", "run", { toolCallId: "two" }));
    assert.deepEqual(waiting, [false, true, true, true, true, true, true]);
    stream.append(event("tool.call.progress", "run", { inputRequestId: "channel" }));
    assert.deepEqual(waiting, [false, true, true, true, true, true, true, false]);
    stream.flush();
    flushFrames();
  });
});
