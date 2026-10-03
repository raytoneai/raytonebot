import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";

/** A Pi session that runs until released, aborted, or (optionally) answered on a write approval. */
function fakeBridges() {
  const release = new Map<string, () => void>();
  const aborted: string[] = [];
  const factory: PiBridgeFactory = async ({ approvalGate, sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let stop: (() => void) | undefined;
    return {
      subscribe: () => () => undefined,
      async prompt(text) {
        if (text === "write") await approvalGate.wait(`call-${id}`, "write", { path: "notes.md" });
        await new Promise<void>((resolve) => {
          release.set(id, resolve);
          stop = resolve;
        });
      },
      async abort() {
        aborted.push(id);
        stop?.();
      },
      dispose: () => undefined,
      configure: async () => undefined,
      state: async () => ({ models: [], tools: [] }) as never,
      newSession: async () => undefined,
    };
  };
  return { factory, release, aborted };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("conversations run in parallel; stop and approval stay inside their own conversation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory, release, aborted } = fakeBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  try {
    const runA = controller.runPrompt({ conversationId: "a", prompt: "write", permissionMode: "request" }, () => undefined);
    const runB = controller.runPrompt({ conversationId: "b", prompt: "hello" }, () => undefined);
    await tick();
    assert.equal((await controller.state("a")).running, true);
    assert.equal((await controller.state("b")).running, true);

    await assert.rejects(
      controller.runPrompt({ conversationId: "a", prompt: "again" }, () => undefined),
      /already has a run/,
    );
    await assert.rejects(controller.newSession("b"), /Stop this conversation's run/);

    // Stopping b leaves a waiting on its approval.
    await controller.abort("b");
    await runB;
    assert.deepEqual(aborted, ["b"]);
    assert.equal((await controller.state("b")).running, false);
    assert.equal((await controller.state("a")).running, true);

    // a's approval is found in a's gate; then a finishes normally.
    assert.equal(controller.resolveApproval("call-a", "yes"), true);
    await tick();
    assert.equal(controller.resolveApproval("call-a", "yes"), false, "an answered approval is no longer pending");
    release.get("a")!();
    await runA;
    assert.equal((await controller.state("a")).running, false);
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent runs are capped, and a stop sent before the run starts still applies", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory, release } = fakeBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  try {
    const runs = ["c1", "c2", "c3"].map((id) => controller.runPrompt({ conversationId: id, prompt: "hi" }, () => undefined));
    await assert.rejects(
      controller.runPrompt({ conversationId: "c4", prompt: "hi" }, () => undefined),
      /3 conversations are already running/,
    );
    // c1's session may not exist yet; the stop is remembered and applied when it does.
    await controller.abort("c1");
    await runs[0];
    await tick();
    release.get("c2")!();
    release.get("c3")!();
    await Promise.all(runs);
    const next = controller.runPrompt({ conversationId: "c4", prompt: "hi" }, () => undefined);
    await tick();
    release.get("c4")!();
    await next;
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
