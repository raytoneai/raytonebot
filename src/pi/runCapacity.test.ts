import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

import { createPiRuntimeController, type PiBridgeFactory, type PiRuntimeController } from "./piHost.ts";

function heldRuns() {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-capacity-"));
  const release = new Map<string, () => void>();
  const started: string[] = [];
  const initialized: string[] = [];
  const aborted: string[] = [];
  const pending: Promise<void>[] = [];
  let peak = 0;
  const factory: PiBridgeFactory = async ({ sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    initialized.push(id);
    return {
      subscribe: () => () => undefined,
      async prompt() {
        started.push(id);
        await new Promise<void>(resolve => {
          release.set(id, resolve);
          peak = Math.max(peak, release.size);
        });
        release.delete(id);
      },
      async abort() { aborted.push(id); release.get(id)?.(); },
      dispose: () => undefined,
      configure: async () => undefined,
      state: async () => ({ models: [], tools: [] }) as never,
      newSession: async () => undefined,
    };
  };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const run = (id: string, options?: Parameters<PiRuntimeController["runPrompt"]>[2], requestId = id) => {
    const result = controller.runPrompt({ conversationId: id, requestId, prompt: "work" }, () => {}, options);
    // Keep rejected queued calls observed even before the test awaits their outcome.
    void result.catch(() => undefined);
    pending.push(result);
    return result;
  };
  return { controller, run, release, started, initialized, aborted, peak: () => peak,
    async close() {
      controller.dispose();
      await controller.abort();
      await Promise.allSettled(pending);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("opted-in runs wait for released capacity and competing waiters never exceed three engines", async () => {
  const host = heldRuns();
  try {
    for (const id of ["a", "b", "c"]) host.run(id);
    await setImmediate();
    const outcomes: string[] = [];
    const queued = ["d", "e", "f", "g"];
    for (const id of queued) void host.run(id, { waitForCapacity: true }).then(() => outcomes.push(id), () => outcomes.push(`${id}:rejected`));
    await setImmediate();
    assert.deepEqual(outcomes, [], "full capacity must leave opted-in requests waiting");
    assert.deepEqual(host.started, ["a", "b", "c"]);
    assert.equal(host.controller.health().activeRuns, 3);
    for (const id of queued) assert.equal(host.controller.getConversation(id), undefined, "waiting is not acceptance");
    await assert.rejects(host.run("ordinary"), /3 conversations are already running/);
    await assert.rejects(host.run("im", { fromChannel: true }), /3 conversations are already running/);

    for (let count = 1; count <= queued.length; count++) {
      host.release.values().next().value!();
      await setImmediate();
      assert.equal(host.started.length, 3 + count, "exactly one waiter claims each available slot");
      assert.equal(host.controller.health().activeRuns, 3);
      assert.equal(host.release.size, 3);
    }
    assert.equal(host.peak(), 3);
    assert.ok(queued.every(id => host.started.includes(id)));
  } finally { await host.close(); }
});

test("cancelling a capacity waiter never starts its engine, accepts its request, or stops another run", async () => {
  const host = heldRuns();
  const cancel = new AbortController();
  try {
    for (const id of ["a", "b", "c"]) host.run(id);
    await setImmediate();
    const waiting = host.run("group.m.assistant", { waitForCapacity: true, signal: cancel.signal });
    await setImmediate();
    assert.equal(getEventListeners(cancel.signal, "abort").length, 1);
    cancel.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
    assert.equal(host.controller.getConversation("group.m.assistant"), undefined);
    assert.ok(!host.initialized.includes("group.m.assistant"));
    assert.deepEqual(host.aborted, []);
    assert.equal(host.controller.health().activeRuns, 3);
    host.release.get("a")!();
    await setImmediate();
    assert.deepEqual(host.started, ["a", "b", "c"], "released capacity cannot resurrect cancellation");
    await assert.rejects(host.run("already-cancelled", { waitForCapacity: true, signal: cancel.signal }), { name: "AbortError" });
    assert.equal(host.controller.getConversation("already-cancelled"), undefined);
  } finally { await host.close(); }
});

test("woken waiters recheck duplicate conversations and rejected signals cannot stop the winner", async () => {
  const host = heldRuns();
  const cancel = new AbortController();
  try {
    for (const id of ["a", "b", "c"]) host.run(id);
    await setImmediate();
    const first = host.run("child", { waitForCapacity: true }, "first");
    const second = host.run("child", { waitForCapacity: true, signal: cancel.signal }, "second");
    host.release.get("a")!();
    await assert.rejects(second, /already has a run in progress/);
    await setImmediate();
    assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
    cancel.abort();
    assert.deepEqual(host.aborted, []);
    assert.equal(host.started.filter(id => id === "child").length, 1);
    host.release.get("child")!();
    await first;
    await assert.rejects(host.run("child", { waitForCapacity: true }, "first"), /already been submitted/);
    assert.deepEqual(host.controller.getConversation("child")?.turns?.map(turn => turn.runId), ["first"]);
  } finally { await host.close(); }
});

test("disposing the host rejects capacity waiters without restarting them when active runs settle", async () => {
  const host = heldRuns();
  const cancel = new AbortController();
  try {
    for (const id of ["a", "b", "c"]) host.run(id);
    await setImmediate();
    const waiting = host.run("queued", { waitForCapacity: true, signal: cancel.signal });
    host.controller.dispose();
    await assert.rejects(waiting, /disposed/);
    assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
    for (const finish of host.release.values()) finish();
    await setImmediate();
    assert.deepEqual(host.started, ["a", "b", "c"]);
    assert.equal(host.controller.getConversation("queued"), undefined);
    await assert.rejects(host.run("late", { waitForCapacity: true }), /disposed/);
  } finally { await host.close(); }
});
