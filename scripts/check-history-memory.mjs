// Run with: node --expose-gc scripts/check-history-memory.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "../src/pi/conversationStore.ts";

assert.equal(typeof global.gc, "function", "Run with --expose-gc.");
const dir = mkdtempSync(join(tmpdir(), "raytone-history-memory-"));
try {
  mkdirSync(join(dir, "conversations"));
  const text = "history payload ".repeat(16_384);
  for (let n = 0; n < 600; n++) writeFileSync(join(dir, "conversations", `c${n}.json`), JSON.stringify({
    id: `c${n}`, title: `History ${n}`, agentPreset: "assistant", createdAt: n, updatedAt: n,
    events: [
      { type: "text.started", id: `s${n}`, runId: `r${n}`, ts: n, seq: 1, payload: { textId: "a", role: "assistant" } },
      { type: "text.delta", id: `d${n}`, runId: `r${n}`, ts: n, seq: 2, payload: { textId: "a", delta: text + ` marker-${n}` } },
    ],
  }));
  global.gc(); const before = process.memoryUsage().heapUsed;
  const store = createConversationStore(dir), start = performance.now();
  assert.equal(store.list().length, 600); const coldMs = performance.now() - start;
  global.gc(); const retainedMiB = (process.memoryUsage().heapUsed - before) / 1_048_576;
  const warmStart = performance.now(); assert.equal(store.list().length, 600);
  const warmMs = performance.now() - warmStart;
  assert.deepEqual(store.list("marker-599").map(row => row.id), ["c599"]);
  global.gc(); const afterSearchMiB = (process.memoryUsage().heapUsed - before) / 1_048_576;
  console.log(JSON.stringify({ conversations: 600, coldMs, warmMs, retainedMiB, afterSearchMiB }));
  assert.ok(Math.max(retainedMiB, afterSearchMiB) < 20, "History browsing/search must not retain all 150 MiB of transcripts.");
} finally { rmSync(dir, { recursive: true, force: true }); }
