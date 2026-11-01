import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runtimeLogger } from "./hostOperations.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";

test("a real group watcher failure writes only its fixed diagnostic identity", async () => {
  const root = mkdtempSync(join("/tmp", "raytone-group-log-"));
  const dataDir = join(root, "data");
  const bridgeFactory: PiBridgeFactory = async () => ({
    subscribe() { return () => {}; },
    async prompt(_prompt: string) {
      // The host adapter receives ordinary successful completion without a model or external service.
    },
    async abort() {}, dispose() {}, async configure() {}, async newSession() {},
    async state() { return { models: [], tools: [] }; },
  });
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory, routineClock: false, browser: false });
  try {
    await host.controller.runGroupPrompt({ conversationId: "group_privacy", requestId: "privacy-run", prompt: "@Raer hello", members: ["assistant"] }, () => {
      throw new Error("PRIVATE-GROUP-WATCHER-MARKER");
    });
    const log = readFileSync(join(root, "logs", "runtime.jsonl"), "utf8");
    assert.match(log, /group\.subscriber_failed/);
    assert.match(log, /group_privacy/);
    assert.match(log, /privacy-run/);
    assert.ok(!log.includes("PRIVATE-GROUP-WATCHER-MARKER"));
  } finally {
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime diagnostics keep bounded metadata and reject caller supplied content", () => {
  const root = mkdtempSync(join(tmpdir(), "raytone-runtime-log-"));
  try {
    const log = runtimeLogger(join(root, "data"));
    const unsafe = log as unknown as (event: string, fields: Record<string, unknown>) => void;
    unsafe("group.subscriber_failed", { conversationId: "group-1", runId: "run-1", error: "PRIVATE-GROUP-WATCHER-MARKER" });
    unsafe("run.started", { conversationId: "conversation-1", harness: { toString: () => "secret" }, injected: "PRIVATE-EXTRA-MARKER" });
    unsafe("run.started", { conversationId: 42, harness: "pi", status: 42, durationMs: "12", nested: { prompt: "PRIVATE-NESTED-MARKER" } });
    unsafe("run.ended", { conversationId: "conversation-1", harness: "unknown", status: 42, durationMs: 3, outputBytes: 4 });
    assert.doesNotThrow(() => unsafe("run.started", undefined as unknown as Record<string, unknown>));
    log("run.started", { conversationId: "conversation-1", harness: "pi" });
    log("run.ended", { conversationId: "conversation-1", harness: "pi", status: "success", durationMs: 12, outputBytes: 34 });
    log("approval.resolved", { conversationId: "conversation-1", decision: "yes" });
    log("browser.input_batch", { count: 2, durationMs: 9 });
    log("channel.connected", { platform: "feishu" });
    log("runtime.cleanup_failed", { conversationId: "conversation-1", status: "bridge" });
    log("group.route", { conversationId: "group-1", mode: "round_robin", source: "router", route: "discussion", rounds: 2, ms: 10, members: ["assistant"] });
    const lines = readFileSync(join(root, "logs", "runtime.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const serialized = JSON.stringify(lines);
    assert.ok(!serialized.includes("PRIVATE-"));
    assert.deepEqual(lines[0], { time: lines[0].time, event: "group.subscriber_failed", conversationId: "group-1", runId: "run-1" });
    assert.deepEqual(lines[1], { time: lines[1].time, event: "run.started", conversationId: "conversation-1" });
    assert.deepEqual(lines[2], { time: lines[2].time, event: "run.started", harness: "pi" });
    assert.deepEqual(lines[3], { time: lines[3].time, event: "run.ended", conversationId: "conversation-1", durationMs: 3, outputBytes: 4 });
    assert.deepEqual(lines[4], { time: lines[4].time, event: "run.started" });
    assert.deepEqual(lines.slice(5).map(({ event, ...fields }) => ({ event, ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "time")) })), [
      { event: "run.started", conversationId: "conversation-1", harness: "pi" },
      { event: "run.ended", conversationId: "conversation-1", harness: "pi", status: "success", durationMs: 12, outputBytes: 34 },
      { event: "approval.resolved", conversationId: "conversation-1", decision: "yes" },
      { event: "browser.input_batch", count: 2, durationMs: 9 },
      { event: "channel.connected", platform: "feishu" },
      { event: "runtime.cleanup_failed", conversationId: "conversation-1", status: "bridge" },
      { event: "group.route", conversationId: "group-1", mode: "round_robin", source: "router", route: "discussion", rounds: 2, ms: 10 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
