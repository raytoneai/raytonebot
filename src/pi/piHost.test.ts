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

test("an approval is answered only inside the conversation it is sent for", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const waits = new Map<string, Promise<string>>();
  const factory: PiBridgeFactory = async ({ approvalGate, sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    return {
      subscribe: () => () => undefined,
      // Both conversations hold the same tool call id, as two same-millisecond Codex runs did.
      async prompt() {
        const outcome = approvalGate.wait("same-id", "write", { path: "notes.md" }).then(() => "approved", () => "denied");
        waits.set(id, outcome);
        await outcome;
      },
      abort: async () => undefined,
      dispose: () => undefined,
      configure: async () => undefined,
      state: async () => ({ models: [], tools: [] }) as never,
      newSession: async () => undefined,
    };
  };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  try {
    const runA = controller.runPrompt({ conversationId: "a", prompt: "x", permissionMode: "request" }, () => undefined);
    const runB = controller.runPrompt({ conversationId: "b", prompt: "x", permissionMode: "request" }, () => undefined);
    await tick();
    assert.equal(controller.resolveApproval("same-id", "no", "b"), true);
    assert.equal(await waits.get("b"), "denied");
    assert.equal(controller.resolveApproval("same-id", "yes", "a"), true);
    assert.equal(await waits.get("a"), "approved");
    await Promise.all([runA, runB]);
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a rejected duplicate's stream closing does not stop the run in progress", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory, release, aborted } = fakeBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  try {
    const first = new AbortController();
    const run = controller.runPrompt({ conversationId: "a", prompt: "hi" }, () => undefined, { signal: first.signal });
    await tick();
    const duplicate = new AbortController();
    await assert.rejects(
      controller.runPrompt({ conversationId: "a", prompt: "again" }, () => undefined, { signal: duplicate.signal }),
      /already has a run/,
    );
    duplicate.abort();
    await tick();
    assert.deepEqual(aborted, []);
    assert.equal((await controller.state("a")).running, true);
    // The run's own stream closing does stop it.
    first.abort();
    await run;
    assert.deepEqual(aborted, ["a"]);
    assert.equal(release.size, 1);
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an approval wait that starts after its run was stopped fails at once", async () => {
  const { PiApprovalGate } = await import("./approvalGate.ts");
  const gate = new PiApprovalGate({ cwd: "/w", protectedPaths: [] });
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(gate.wait("t1", "write", { path: "a.md" }, stopped.signal), /cancelled/);
});

test("always-allow carries over to the agent's next conversation until it is reset", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const asked: string[] = [];
  const factory: PiBridgeFactory = async ({ approvalGate, sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    return {
      subscribe: () => () => undefined,
      async prompt() {
        if (approvalGate.requiresApproval("write", { path: "notes.md" })) asked.push(id);
        await approvalGate.wait(`call-${id}`, "write", { path: "notes.md" });
      },
      abort: async () => undefined,
      dispose: () => undefined,
      configure: async () => undefined,
      state: async () => ({ models: [], tools: [] }) as never,
      newSession: async () => undefined,
    };
  };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const turn = (conversationId: string) =>
    controller.runPrompt({ conversationId, prompt: "x", permissionMode: "request", agentPreset: "assistant" }, () => undefined);
  try {
    const first = turn("a");
    await tick();
    controller.resolveApproval("call-a", "always", "a");
    await first;
    await controller.newSession("a");
    await turn("b");
    await turn("a");
    assert.deepEqual(asked, ["a"], "asked once, in the first conversation only");
    assert.deepEqual((await controller.state("b")).alwaysAllowed, { assistant: ["write"] });

    assert.deepEqual(controller.clearApprovals("assistant"), {});
    const again = turn("c");
    await tick();
    assert.deepEqual(asked, ["a", "c"]);
    controller.resolveApproval("call-c", "yes", "c");
    await again;
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** A session that streams text until released, so a run is observably "in flight". */
function streamingBridges() {
  const release = new Map<string, () => void>();
  const aborted: string[] = [];
  const factory: PiBridgeFactory = async ({ sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    let listener: ((event: never) => void) | undefined;
    let stop: (() => void) | undefined;
    return {
      subscribe(next) {
        listener = next as never;
        return () => { listener = undefined; };
      },
      async prompt() {
        const emit = (event: unknown) => listener?.(event as never);
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });
        await new Promise<void>((resolve) => {
          release.set(id, resolve);
          stop = resolve;
        });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " done" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
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

test("a watcher sees saved events past `after`, then live ones; leaving does not stop the run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory, release, aborted } = streamingBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  try {
    assert.equal(controller.followRun("a", 0, () => undefined), undefined, "nothing running yet");
    const run = controller.runPrompt({ conversationId: "a", prompt: "hi" }, () => undefined);
    await tick();
    assert.equal(controller.listConversations().find((entry) => entry.id === "a")?.running, true);
    const saved = controller.getConversation("a")!.events.length;
    assert.ok(saved >= 2);

    const seen: string[] = [];
    const follow = controller.followRun("a", 1, (event) => seen.push(event.type))!;
    assert.equal(seen.length, saved - 1, "replays everything past `after`");
    const early = controller.followRun("a", saved, () => undefined)!;
    early.stop();
    release.get("a")!();
    await follow.done;
    await run;
    assert.equal(seen.at(-1), "run.finished");
    assert.equal(seen.length, controller.getConversation("a")!.events.length - 1, "live events followed without gaps");
    assert.deepEqual(aborted, []);
    assert.equal(controller.listConversations().find((entry) => entry.id === "a")?.running, false);
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a turn left open by the last process is closed as interrupted, not replayed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory } = streamingBridges();
  try {
    const { createConversationStore } = await import("./conversationStore.ts");
    const firstStore = createConversationStore(dataDir);
    const first = createPiRuntimeController({ cwd: dataDir, dataDir, store: firstStore, bridgeFactory: factory });
    void first.runPrompt({ conversationId: "a", prompt: "hi" }, () => undefined);
    await tick();
    firstStore.flush("a"); // what the periodic flush had written when the process died
    const second = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
    const events = second.getConversation("a")!.events;
    assert.equal(events.at(-1)?.type, "run.finished");
    assert.equal((events.at(-1)?.payload as { status?: string }).status, "cancelled");
    assert.equal(second.listConversations().find((entry) => entry.id === "a")?.running, false);
    first.dispose();
    second.dispose();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("over HTTP, a closed prompt stream leaves the turn running and /live reattaches", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  const { factory, release, aborted } = streamingBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const server = createServer((req, res) => {
    void host.handle(req, res).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  try {
    const leave = new AbortController();
    const prompt = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "a", prompt: "hi" }),
      signal: leave.signal,
    });
    const reader = prompt.body!.getReader();
    await reader.read();
    leave.abort(); // the tab closes
    await tick();

    const list = await (await fetch(`${base}/conversations`)).json() as { conversations: { id: string; running: boolean }[] };
    assert.equal(list.conversations.find((entry) => entry.id === "a")?.running, true);

    const live = await fetch(`${base}/conversations/a/live?after=0`);
    assert.equal(live.status, 200);
    const text = live.text();
    await tick();
    release.get("a")!();
    const lines = (await text).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as { type: string });
    assert.equal(lines.at(-1)?.type, "run.finished");
    assert.ok(lines.some((line) => line.type === "text.delta"));
    assert.deepEqual(aborted, [], "nobody stopped it");
    assert.equal((await fetch(`${base}/conversations/a/live?after=0`)).status, 409, "finished: nothing to follow");
  } finally {
    host.controller.dispose();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
