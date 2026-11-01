import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createPiHttpHost, createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";

const fakeBridge = (): Awaited<ReturnType<PiBridgeFactory>> => ({
  subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose() {},
  configure: async () => {}, newSession: async () => {}, state: async () => ({ models: [], tools: [] }),
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("host disposal waits for a running CLI to exit and persist cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-dispose-cli-"));
  const marker = join(root, "counter");
  const bin = join(root, "claude.cjs");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("test-cli"); process.exit(0); }
let count = 0;
const tick = () => fs.writeFileSync(${JSON.stringify(marker)}, String(++count));
tick(); setInterval(tick, 20); process.stdin.resume();
`);
  chmodSync(bin, 0o700);
  const previous = process.env.RAYTONEBOT_CLAUDE_BIN;
  process.env.RAYTONEBOT_CLAUDE_BIN = bin;
  const host = createPiHttpHost({ cwd: root, dataDir: join(root, "data"), browser: false, routineClock: false,
    bridgeFactory: async () => fakeBridge() });
  const events: AgentUXEvent[] = [];
  const run = host.controller.runPrompt({ conversationId: "cli", requestId: "cli-run", agentPreset: "planner",
    claudeCodeModelSource: "local-login", prompt: "Controlled lifecycle test" }, event => events.push(event));
  try {
    for (let n = 0; n < 200 && !existsSync(marker); n++) await delay(10);
    assert.ok(existsSync(marker), "the controlled CLI must be running");
    const closing = host.dispose();
    assert.equal(host.dispose(), closing, "repeated disposal shares the completion promise");
    await closing;
    assert.equal(host.controller.health().activeRuns, 0);
    const stoppedCount = readFileSync(marker, "utf8");
    await delay(70);
    assert.equal(readFileSync(marker, "utf8"), stoppedCount, "the process cannot keep writing after disposal resolves");
    assert.equal(events.filter(event => event.type === "run.finished" && event.payload.status === "cancelled").length, 1);
    assert.equal(host.controller.getConversation("cli")?.incomplete, false);
    await assert.rejects(host.controller.runPrompt({ conversationId: "late", prompt: "Must not start" }, () => {}), /disposed/);
    await assert.rejects(host.controller.runGroupPrompt({ conversationId: "late-group", members: ["assistant"], prompt: "Must not start" }, () => {}), /disposed/);
  } finally {
    await host.controller.abort();
    await run;
    await host.dispose();
    if (previous === undefined) delete process.env.RAYTONEBOT_CLAUDE_BIN;
    else process.env.RAYTONEBOT_CLAUDE_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("disposal waits for a late Pi bridge and stops it before prompting", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-dispose-starting-"));
  const entered = deferred<void>();
  const ready = deferred<Awaited<ReturnType<PiBridgeFactory>>>();
  const calls: string[] = [];
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async () => {
    entered.resolve(); return ready.promise;
  } });
  const run = controller.runPrompt({ conversationId: "starting", prompt: "Do not execute after shutdown" }, () => {});
  try {
    await entered.promise;
    const closing = controller.dispose();
    let closed = false;
    void Promise.resolve(closing).then(() => { closed = true; });
    await delay(0);
    assert.equal(closed, false, "disposal must wait for the registered run to finish");
    ready.resolve({ ...fakeBridge(), prompt: async () => { calls.push("prompt"); },
      abort: async () => { calls.push("abort"); }, dispose() { calls.push("dispose"); } });
    await closing;
    await run;
    assert.deepEqual(calls, ["abort", "dispose"]);
    assert.equal(controller.health().activeRuns, 0);
  } finally {
    ready.resolve(fakeBridge());
    await controller.abort(); await run; await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const group of [false, true]) test(`disposal waits for ${group ? "group" : "single"} Pi abort cleanup even when the prompt settles first`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-dispose-pi-"));
  const prompted = deferred<void>();
  const promptDone = deferred<void>();
  const aborting = deferred<void>();
  const cleanupDone = deferred<void>();
  let disposedBridge = 0;
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async () => {
    let wasPrompted = false;
    return { ...fakeBridge(), prompt: async () => { wasPrompted = true; prompted.resolve(); await promptDone.promise; },
      abort: async () => { aborting.resolve(); promptDone.resolve(); await cleanupDone.promise; },
      dispose() { if (wasPrompted) disposedBridge++; },
    };
  } });
  const run = group
    ? controller.runGroupPrompt({ conversationId: "group-pi", prompt: "@Raer Wait", members: ["assistant"] }, () => {})
    : controller.runPrompt({ conversationId: "pi", prompt: "Wait" }, () => {});
  try {
    await prompted.promise;
    const closing = controller.dispose();
    await Promise.race([aborting.promise, delay(1000).then(() => { throw new Error("Pi abort was not called"); })]);
    if (!group) await run;
    else await delay(0);
    assert.equal(disposedBridge, 0, "the bridge stays alive until its abort finishes");
    cleanupDone.resolve();
    await closing;
    await run;
    assert.equal(disposedBridge, 1);
    assert.equal(controller.health().busy, false);
  } finally {
    promptDone.resolve(); cleanupDone.resolve();
    await controller.abort(); await run; await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one rejected stop cannot dispose a different bridge before its abort cleanup finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-dispose-parallel-"));
  const ready = [deferred<void>(), deferred<void>()];
  const finished = [deferred<void>(), deferred<void>()];
  const slowCleanup = deferred<void>();
  const disposed: string[] = [];
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async ({ sessionDir }) => {
    const id = sessionDir!.split("/").at(-1)!;
    const index = id === "failing" ? 0 : 1;
    return { ...fakeBridge(), prompt: async () => { ready[index].resolve(); await finished[index].promise; },
      abort: async () => {
        finished[index].resolve();
        if (index === 0) throw new Error("controlled abort failure");
        await slowCleanup.promise;
      },
      dispose() { disposed.push(id); },
    };
  } });
  const runs = ["failing", "slow"].map(conversationId => controller.runPrompt({ conversationId, prompt: "Wait" }, () => {}));
  try {
    await Promise.all(ready.map(value => value.promise));
    const closing = controller.dispose();
    await Promise.all(runs);
    await delay(0);
    assert.deepEqual(disposed, [], "a rejected stop cannot shortcut another stop's cleanup");
    slowCleanup.resolve();
    await closing;
    assert.deepEqual(disposed.sort(), ["failing", "slow"]);
  } finally {
    for (const value of finished) value.resolve();
    slowCleanup.resolve();
    await Promise.all(runs); await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cleanup of ["dispose", "evict"] as const) {
  test(`${cleanup} handles a pending bridge rejection without an unhandled cleanup promise`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rtb-dispose-rejected-"));
    const entered = deferred<void>();
    const ready = deferred<Awaited<ReturnType<PiBridgeFactory>>>();
    let first = true;
    const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async () => {
      if (first) { first = false; entered.resolve(); return ready.promise; }
      return fakeBridge();
    } });
    const configured = controller.configure({ conversationId: "pending" }).catch(error => error.message);
    try {
      await entered.promise;
      let closing: unknown;
      if (cleanup === "dispose") closing = controller.dispose();
      else for (let n = 0; n < 12; n++) await controller.runPrompt({ conversationId: `other-${n}`, prompt: "test" }, () => {});
      ready.reject(new Error("controlled initialization failure"));
      assert.equal(await configured, "controlled initialization failure");
      await closing;
      await delay(20); // The test runner fails if a detached cleanup rejects on a later turn.
    } finally {
      ready.resolve(fakeBridge());
      await controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${cleanup} handles bridge dispose failures and still releases the remaining bridges`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rtb-dispose-throw-"));
    const disposed: string[] = [];
    const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async ({ sessionDir }) => {
      const id = sessionDir!.split("/").at(-1)!;
      return { ...fakeBridge(), dispose() { disposed.push(id); if (id === "throwing") throw new Error("controlled cleanup failure"); } };
    } });
    try {
      await controller.runPrompt({ conversationId: "throwing", prompt: "test" }, () => {});
      const count = cleanup === "evict" ? 12 : 1;
      for (let n = 0; n < count; n++) await controller.runPrompt({ conversationId: `other-${n}`, prompt: "test" }, () => {});
      await controller.dispose();
      await delay(20);
      assert.equal(disposed.length, count + 1);
      assert.equal(new Set(disposed).size, count + 1, "each bridge is released once");
    } finally { await controller.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
}
