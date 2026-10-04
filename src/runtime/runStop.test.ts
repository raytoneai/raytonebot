import assert from "node:assert/strict";
import test from "node:test";
import { requestRunStop } from "./runStop.ts";

test("stop failures keep the run attached, retries confirm, and late responses cannot stop a replacement", async () => {
  const first = new AbortController(), controllers = new Map([["a", first]]), pending = new Map<string, string>();
  const runIds = new WeakMap([[first, "first-run"]]);
  const updates: string[] = [], report = (id: string, state: { status: string }) => updates.push(`${id}:${state.status}`);
  let calls = 0;
  let reject!: (error: Error) => void;
  const failed = new Promise<void>((_resolve, fail) => { reject = fail; });
  const send = () => { calls++; return failed; };
  const attempt = requestRunStop("a", controllers, new Set(), pending, report, runIds, send);
  await requestRunStop("a", controllers, new Set(), pending, report, runIds, send);
  assert.equal(calls, 1);
  reject(new Error("503")); await attempt;
  assert.deepEqual(updates, ["a:pending", "a:failed"]);
  assert.equal(first.signal.aborted, false);
  await requestRunStop("a", controllers, new Set(), pending, report, runIds, async () => { calls++; });
  assert.equal(calls, 2); assert.equal(first.signal.aborted, true);

  let resolve!: () => void;
  const late = new Promise<void>(done => { resolve = done; });
  const old = new AbortController(), replacement = new AbortController();
  controllers.set("a", old); runIds.set(old, "old-run"); updates.length = 0;
  const oldAttempt = requestRunStop("a", controllers, new Set(), pending, report, runIds, () => late);
  controllers.set("a", replacement);
  resolve(); await oldAttempt;
  assert.equal(replacement.signal.aborted, false);
  assert.deepEqual(updates, ["a:pending"]);
  await requestRunStop("a", controllers, new Set(["a"]), pending, report, runIds, async () => { throw new Error("must not send during preparation"); });
  assert.equal(replacement.signal.aborted, true);
});

test("missing identities never send an unscoped stop; a rebound subscription ignores an old receipt", async () => {
  const controller = new AbortController(), controllers = new Map([["a", controller]]);
  const pending = new Map<string, string>(), runIds = new WeakMap<AbortController, string>();
  const updates: string[] = [], report = (_id: string, state: { status: string }) => updates.push(state.status);
  const sent: string[] = [], finish: (() => void)[] = [];
  const send = async (_id: string, runId: string) => { sent.push(runId); await new Promise<void>(resolve => finish.push(resolve)); };
  const stop = () => requestRunStop("a", controllers, new Set(), pending, report, runIds, send);
  await stop(); assert.deepEqual(sent, []); assert.deepEqual(updates, ["failed"]);
  runIds.set(controller, "old"); const first = stop();
  runIds.set(controller, "new"); const second = stop();
  assert.deepEqual(sent, ["old", "new"]);
  finish[0](); await first;
  assert.equal(controller.signal.aborted, false); assert.equal(pending.get("a"), "new");
  finish[1](); await second;
  assert.equal(controller.signal.aborted, true); assert.equal(pending.size, 0);
});
