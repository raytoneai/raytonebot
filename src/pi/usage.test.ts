import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageService } from "./usage.ts";
import { USAGE_REQUEST_LIMIT, USAGE_RUN_LIMIT, type UsageStart } from "./usageTypes.ts";

const start: UsageStart = { runId: "run-1", conversationId: "conversation-1", botId: "assistant", harness: "pi", provider: "custom-provider", model: "model", startedAt: 1000 };

test("request upsert replaces cumulative usage and unknown requests make coverage explicit", () => {
  const usage = createUsageService({ now: () => 2000 });
  usage.start(start);
  assert.equal(usage.list().runs[0].coverage, "unknown");
  assert.deepEqual(usage.list().runs[0].totals, {});
  usage.record(start.runId, "request-1", { source: "gateway", complete: false, inputTokens: 100, outputTokens: 2, cacheReadTokens: 80 });
  usage.record(start.runId, "request-1", { source: "gateway", complete: true, outputTokens: 10 });
  usage.record(start.runId, "request-1", { source: "gateway", complete: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 });
  let row = usage.list().runs[0];
  assert.equal(row.requestCount, 1);
  assert.equal(row.coverage, "complete");
  assert.equal(row.totals.cacheWriteTokens, undefined);
  assert.deepEqual(row.totals, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 });
  usage.record(start.runId, "request-2", { source: "gateway", complete: false });
  usage.end(start.runId, "completed");
  row = usage.list().runs[0];
  assert.equal(row.status, "completed");
  assert.equal(row.endedAt, 2000);
  assert.equal(row.requestCount, 2);
  assert.equal(row.knownRequestCount, 1);
  assert.equal(row.completeRequestCount, 1);
  assert.equal(row.coverage, "partial");
  assert.deepEqual(row.tokenRequests, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 });
  row.totals.inputTokens = 999;
  assert.equal(usage.list().runs[0].totals.inputTokens, 100);
});

test("usage history survives restart with independent runs, explicit zeros, and interrupted active rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-usage-"));
  try {
    const usage = createUsageService({ dataDir: dir, now: () => 3000 });
    usage.start(start);
    usage.record(start.runId, "request-1", { source: "gateway", complete: true, inputTokens: 0, outputTokens: 0 });
    usage.end(start.runId, "completed");
    usage.start({ ...start, runId: "run-2", startedAt: 2000 });
    usage.record("run-2", "request-2", { source: "gateway", complete: false, inputTokens: 8 });
    const next = createUsageService({ dataDir: dir });
    const [active, completed] = next.list().runs;
    assert.equal(active.status, "interrupted");
    assert.equal(active.coverage, "partial");
    assert.equal(completed.status, "completed");
    assert.equal(completed.coverage, "complete");
    assert.deepEqual(completed.totals, { inputTokens: 0, outputTokens: 0 });
    next.record(start.runId, "request-1", { source: "gateway", complete: true, inputTokens: 3, outputTokens: 2 });
    assert.equal(next.list().runs[1].requestCount, 1);
    assert.equal(next.list().runs[1].totals.inputTokens, 3);
    assert.equal(statSync(join(dir, "usage.json")).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same run ID in different conversations retains separate usage and completion across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-usage-conversations-"));
  try {
    const usage = createUsageService({ dataDir: dir });
    usage.start({ ...start, runId: "first", conversationId: "chat-a" });
    usage.start({ ...start, runId: "first", conversationId: "chat-b" });
    usage.start({ ...start, runId: "first", conversationId: "chat-a" });
    assert.equal(usage.list().runs.length, 2, "only an identical conversation/run pair is idempotent");
    usage.record("first", "request", { source: "gateway", complete: true, inputTokens: 10, outputTokens: 1 }, "chat-a");
    usage.record("first", "request", { source: "gateway", complete: true, inputTokens: 20, outputTokens: 2 }, "chat-b");
    usage.record("first", "ambiguous", { source: "gateway", complete: true, inputTokens: 99, outputTokens: 99 });
    usage.end("first", "failed");
    assert.ok(usage.list().runs.every(run => run.status === "running"), "an ambiguous old-style caller cannot change another conversation");
    usage.end("first", "completed", "chat-a");
    usage.end("first", "cancelled", "chat-b");
    const restored = createUsageService({ dataDir: dir }).list();
    assert.equal(restored.storageError, undefined);
    assert.deepEqual(restored.runs.map(run => ({ conversationId: run.conversationId, count: run.requestCount, input: run.totals.inputTokens, status: run.status }))
      .sort((a, b) => a.conversationId.localeCompare(b.conversationId)), [
      { conversationId: "chat-a", count: 1, input: 10, status: "completed" },
      { conversationId: "chat-b", count: 1, input: 20, status: "cancelled" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retention bounds rows and request IDs while exposing truncated coverage", () => {
  const usage = createUsageService();
  for (let index = 0; index <= USAGE_RUN_LIMIT; index++) usage.start({ ...start, runId: `run-${index}`, startedAt: index });
  assert.equal(usage.list().runs.length, USAGE_RUN_LIMIT);
  assert.equal(usage.list().runs[0].runId, `run-${USAGE_RUN_LIMIT}`);
  assert.ok(!usage.list().runs.some(row => row.runId === "run-0"));
  for (let index = 0; index <= USAGE_REQUEST_LIMIT; index++) usage.record(`run-${USAGE_RUN_LIMIT}`, `request-${index}`, { source: "gateway", complete: true, inputTokens: 1, outputTokens: 2 });
  const row = usage.list().runs[0];
  assert.equal(row.requestCount, USAGE_REQUEST_LIMIT);
  assert.equal(row.totals.inputTokens, USAGE_REQUEST_LIMIT);
  assert.equal(row.coverage, "partial");
  assert.equal(row.truncated, true);
});

test("a write failure preserves previous disk data, retains in-memory usage and disables automatic write retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-usage-failure-"));
  const dataDir = join(dir, "data"), backupDir = join(dir, "backup");
  try {
    const usage = createUsageService({ dataDir });
    usage.start(start);
    const previous = readFileSync(join(dataDir, "usage.json"), "utf8");
    renameSync(dataDir, backupDir); writeFileSync(dataDir, "not a directory");
    assert.doesNotThrow(() => usage.record(start.runId, "request-1", { source: "gateway", complete: true, inputTokens: 9, outputTokens: 5 }));
    assert.match(usage.list().storageError!, /could not be saved/);
    assert.equal(usage.list().runs[0].totals.inputTokens, 9);
    assert.equal(readFileSync(join(backupDir, "usage.json"), "utf8"), previous);
    rmSync(dataDir); renameSync(backupDir, dataDir);
    usage.end(start.runId, "completed");
    assert.equal(usage.list().runs[0].status, "completed");
    assert.equal(readFileSync(join(dataDir, "usage.json"), "utf8"), previous, "no automatic retry after telemetry storage fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("damaged usage history is preserved, and input cannot persist arbitrary prompt or secret fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-usage-damaged-"));
  try {
    const file = join(dir, "usage.json"); writeFileSync(file, "damaged");
    const usage = createUsageService({ dataDir: dir });
    usage.start({ ...start, prompt: "private prompt", apiKey: "private key" } as UsageStart);
    usage.record(start.runId, "request-1", { source: "gateway", complete: false, inputTokens: 2, secret: "private key" } as any);
    usage.end(start.runId, "failed");
    assert.match(usage.list().storageError!, /could not be read/);
    assert.equal(readFileSync(file, "utf8"), "damaged");
    assert.doesNotMatch(JSON.stringify(usage.list()), /private prompt|private key/);
    assert.equal(usage.list().runs[0].totals.inputTokens, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
