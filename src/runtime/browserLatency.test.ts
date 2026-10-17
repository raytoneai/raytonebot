import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserLatencyTracker } from "./browserLatency.ts";

test("only the displayed input's correlated frame counts; resets and old frames cannot invent latency", () => {
  let now = 0; const tracker = createBrowserLatencyTracker(() => now);
  tracker.begin("a"); now = 30; tracker.displayed(); tracker.displayed("unrelated");
  assert.equal(tracker.summary().count, 0);
  tracker.displayed("a"); tracker.displayed("a");
  assert.deepEqual(tracker.summary(), { count: 1, p50: 30, p95: 30, pending: 0, missed: 0 });
  tracker.begin("stopped"); tracker.reset(); now = 1000; tracker.displayed("stopped");
  assert.equal(tracker.summary().count, 1); assert.equal(tracker.summary().missed, 1);
  for (let i = 0; i < 250; i++) { tracker.begin(String(i)); now += 10; tracker.displayed(String(i)); }
  assert.deepEqual(tracker.summary(), { count: 200, p50: 10, p95: 10, pending: 0, missed: 1 });
});
