import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createConversationRecorder } from "./conversationRecorder.ts";
import { createConversationStore } from "./conversationStore.ts";

test("wait observations overwrite incoming clocks and are durable before readers see them", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-wait-clock-"));
  const store = createConversationStore(dir);
  try {
    store.begin("conversation", "assistant", "test");
    let now = 10_000;
    const recorder = createConversationRecorder({ store, conversationId: "conversation", runId: "run", now: () => now,
      stop() { assert.fail("storage must not fail"); }, broadcast(event) {
        const saved = createConversationStore(dir).get("conversation")!.events.at(-1)!;
        assert.equal(saved.payload.waitObservedAt, now);
        assert.equal(event.payload.waitObservedAt, now);
        assert.equal(event.ts, 1, "original adapter time stays untouched");
      } });
    for (const type of ["tool.call.awaiting_approval", "run.awaiting_input"]) {
      const event: AgentUXEvent = { protocol: "agent-ux", version: "0.1", type, id: type, runId: "run", seq: 1, ts: 1,
        payload: { toolCallId: "native", requestId: "question", waitObservedAt: 999_999 } };
      recorder.record(event);
      assert.equal(event.payload.waitObservedAt, 999_999, "the source object is not mutated");
      now += 10_000;
    }
    assert.equal(recorder.finish(), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
