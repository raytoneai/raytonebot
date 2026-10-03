import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { conversationTitle, createConversationStore } from "./conversationStore.ts";

const event = (type: string, seq: number) => ({ type, seq, id: `e${seq}`, runId: "r", ts: seq, payload: {} }) as never;

test("conversations survive a new store instance (a server restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-"));
  try {
    const first = createConversationStore(dir);
    first.begin("c1", "planner", "plan the   release\nnow");
    first.append("c1", event("run.started", 1));
    first.append("c1", event("run.started", 1));
    first.flush("c1");
    first.setCliSession("c1", { harness: "claude-code", id: "sess-1" });
    first.begin("c2", "assistant", "hi");

    const second = createConversationStore(dir);
    const restored = second.get("c1");
    assert.equal(restored?.title, "plan the release now");
    assert.equal(restored?.agentPreset, "planner");
    assert.deepEqual(restored?.events.map((entry) => (entry as { seq: number }).seq), [1, 2], "seq is conversation-wide");
    assert.deepEqual(restored?.cliSession, { harness: "claude-code", id: "sess-1" });
    assert.deepEqual(second.list().map((entry) => entry.id).sort(), ["c1", "c2"]);
    assert.equal(second.list().find((entry) => entry.id === "c1")?.eventCount, 2);
    assert.ok(!readdirSync(join(dir, "conversations")).some((name) => name.endsWith(".tmp")), "no half-written files");

    second.reset("c1");
    assert.equal(createConversationStore(dir).get("c1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ids cannot escape the store directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-"));
  try {
    const store = createConversationStore(dir);
    assert.throws(() => store.begin("../../etc/passwd", "assistant", "x"));
    assert.equal(existsSync(join(dir, "..", "etc")), false);
    assert.equal(conversationTitle(""), "New conversation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
