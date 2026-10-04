import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("HTTP stop identities reject old or malformed requests without stopping the current run", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-stop-identity-"));
  const { factory, release, aborted } = fakeBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/abort`;
  const stop = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = host.controller.runPrompt({ conversationId: "a", requestId: "first", prompt: "wait" }, () => {});
    await tick(); release.get("a")!(); await first;
    const second = host.controller.runPrompt({ conversationId: "a", requestId: "second", prompt: "wait" }, () => {});
    const other = host.controller.runPrompt({ conversationId: "b", requestId: "other", prompt: "wait" }, () => {});
    await tick();
    const listed = await (await fetch(url.replace("/abort", "/conversations"))).json();
    const detail = await (await fetch(url.replace("/abort", "/conversations/a"))).json();
    assert.equal(listed.conversations.find((entry: { id: string }) => entry.id === "a").activeRunId, "second");
    assert.equal(detail.activeRunId, "second");
    assert.equal((await stop({ conversationId: "a", runId: "first" })).status, 409);
    for (const body of [{ conversationId: "a", runId: "" }, { conversationId: "a", runId: " " }, { conversationId: "a", runId: 42 }, { runId: "second" }, { conversationId: "" }, { conversationId: " " }])
      assert.equal((await stop(body)).status, 400);
    assert.deepEqual(aborted, []);
    assert.equal(host.controller.health().activeRuns, 2);
    assert.equal((await stop({ conversationId: "a", runId: "second" })).status, 200);
    await second; assert.deepEqual(aborted, ["a"]);
    assert.equal((await stop({ conversationId: "a", runId: "second" })).status, 409);
    assert.equal((await stop({ conversationId: "b" })).status, 200, "legacy scoped stop remains supported");
    await other;
    assert.equal((await stop({})).status, 200, "explicit administrative stop-all remains supported");
  } finally {
    await host.controller.abort(); host.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTP approvals cannot resolve a later run reusing the same native tool id", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-approval-run-"));
  const { factory, release } = fakeBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/approval`;
  const answer = (runId: unknown, decision = "yes") => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "a", toolCallId: "call-a", decision, runId }) });
  try {
    const first = host.controller.runPrompt({ conversationId: "a", prompt: "write", requestId: "first", permissionMode: "request" }, () => {});
    await tick();
    assert.equal((await answer("first")).status, 200);
    await tick(); release.get("a")!(); await first; release.delete("a");
    const second = host.controller.runPrompt({ conversationId: "a", prompt: "write", requestId: "second", permissionMode: "request" }, () => {});
    await tick();
    assert.equal((await answer("first")).status, 409);
    assert.equal((await answer(42)).status, 400);
    assert.equal((await answer("")).status, 400);
    assert.equal(release.has("a"), false, "stale/invalid approval must leave the new tool waiting");
    assert.equal((await answer("second", "no")).status, 200);
    await second;
    assert.equal(release.has("a"), false, "denial never reaches execution");
    assert.equal((await answer("second")).status, 409);
  } finally {
    await host.controller.abort(); host.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("saved user input and terminal events are on disk before a live reader can acknowledge them", async () => {
  const { createConversationStore } = await import("./conversationStore.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-receipts-"));
  const { factory, release } = fakeBridges();
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const snapshots: { type: string; types: string[]; text: string }[] = [];
  try {
    const running = controller.runPrompt({ conversationId: "receipts", prompt: "Keep this original prompt", requestId: "receipt-run" }, (event) => {
      if (!["text.finished", "run.finished"].includes(event.type)) return;
      const saved = createConversationStore(dataDir).get("receipts")!.events;
      snapshots.push({ type: event.type, types: saved.map((e) => e.type), text: saved.filter((e) => e.type === "text.delta").map((e) => e.payload.delta).join("") });
    });
    await tick();
    release.get("receipts")!();
    await running;
    assert.equal(snapshots[0].text, "Keep this original prompt");
    assert.equal(snapshots[0].types.at(-1), "text.finished");
    assert.equal(snapshots.at(-1)?.types.at(-1), "run.finished");
  } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("HTTP history reports corrupt records without hiding healthy ones or starting an engine against unreadable history", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const { createConversationStore } = await import("./conversationStore.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-history-failure-"));
  const seed = createConversationStore(dataDir);
  seed.begin("healthy", "assistant", "A preserved conversation");
  const brokenPath = join(seed.dir, "broken.json");
  writeFileSync(brokenPath, '{"events":');
  mkdirSync(join(seed.dir, "unwritable.json.tmp"));
  let engineStarts = 0;
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: async () => { engineStarts++; throw new Error("Must not start"); } });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  try {
    const index = await (await fetch(`${base}/conversations`)).json();
    assert.deepEqual(index.conversations.map((entry: { id: string }) => entry.id), ["healthy"]);
    assert.deepEqual(index.unreadable, ["broken"]);
    assert.equal((await fetch(`${base}/conversations/broken`)).status, 500, "a read error is not 404");
    for (const conversationId of ["broken", "unwritable"]) {
      const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, requestId: "rejected-id", prompt: "Do not lose this draft" }) });
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.at(-1).payload.code, "prompt_rejected", "the browser must keep the draft");
    }
    assert.equal(engineStarts, 0);
    assert.equal(host.controller.health().activeRuns, 0);
    assert.equal(readFileSync(brokenPath, "utf8"), '{"events":');
    assert.equal((await fetch(`${base}/conversations/unwritable`)).status, 404);
  } finally { host.dispose(); await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); }
});

test("write failure before acceptance or during a run reports one honest terminal to the caller and followers", async () => {
  for (const phase of ["prompt", "stream", "terminal"]) {
    const dataDir = mkdtempSync(join(tmpdir(), "rtb-write-failure-"));
    const blocked = join(dataDir, "conversations", "a.json.tmp");
    let emit: (event: any) => void = () => {};
    let prompts = 0;
    let inject = true;
    const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: async () => ({
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt() {
        prompts++;
        emit({ type: "message_start", message: { role: "assistant" } });
        if (inject && phase === "stream") mkdirSync(blocked);
        for (let i = 0; i < 45; i++) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "response" } });
        if (inject && phase === "terminal") mkdirSync(blocked);
        emit({ type: "agent_settled" });
      },
      async state() { if (inject && phase === "prompt") mkdirSync(blocked); return { models: [], tools: [] } as never; },
      async abort() {}, async configure() {}, async newSession() {}, dispose() {},
    }) });
    const events: any[] = [], followed: any[] = [];
    try {
      await controller.runPrompt({ conversationId: "a", requestId: "failed-run", prompt: "Keep this prompt" }, (event) => {
        events.push(event);
        if (event.type === "run.started") controller.followRun("a", 0, (e) => followed.push(e));
      });
      for (const received of [events, followed]) {
        const terminals = received.filter((event) => ["run.finished", "run.error"].includes(event.type));
        assert.equal(terminals.length, 1, phase);
        assert.equal(terminals[0].type, "run.error", phase);
        assert.equal(terminals[0].payload.code, phase === "prompt" ? "prompt_rejected" : "history_save_failed");
        assert.match(terminals[0].payload.message, /could not be saved/);
      }
      assert.equal(prompts, phase === "prompt" ? 0 : 1);
      assert.equal(controller.health().activeRuns, 0);
      const saved = JSON.parse(readFileSync(join(dataDir, "conversations", "a.json"), "utf8"));
      assert.deepEqual(controller.getConversation("a")?.events, saved.events, "reattach must not recover an unsaved success");
      assert.equal(controller.getConversation("a")?.incomplete, phase !== "prompt", "a refresh must still report the missing terminal");
      assert.ok(!saved.events.some((event: any) => event.type === "run.finished"));
      const restarted = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: async () => { throw new Error("Must not replay"); } });
      try { assert.equal(restarted.getConversation("a")?.incomplete, phase !== "prompt"); }
      finally { restarted.dispose(); }
      inject = false;
      rmSync(blocked, { recursive: true });
      const retried: any[] = [];
      await controller.runPrompt({ conversationId: "a", requestId: "retry-run", prompt: "Explicit retry" }, (event) => retried.push(event));
      assert.equal(retried.at(-1)?.type, "run.finished");
      assert.equal(controller.getConversation("a")?.incomplete, false);
    } finally { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
  }
});

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
    const runs = ["c1", "c2", "c3"].map((id) => controller.runPrompt({ conversationId: id, requestId: `${id}-run`, prompt: "hi" }, () => undefined));
    await assert.rejects(
      controller.runPrompt({ conversationId: "c4", prompt: "hi" }, () => undefined),
      /3 conversations are already running/,
    );
    // c1's session may not exist yet; the matching stop is applied when it does.
    assert.equal(await controller.abort("c1", "stale"), false);
    assert.equal(await controller.abort("c1", "c1-run"), true);
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

test("restart closes a run waiting for its first response even with no open blocks", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-host-"));
  try {
    const { createConversationStore } = await import("./conversationStore.ts");
    const { createPiEventAdapter } = await import("../harness/adapters/piAdapter.ts");
    const store = createConversationStore(dataDir);
    store.begin("waiting", "builder", "hi");
    const adapter = createPiEventAdapter({ runId: "waiting-run" });
    for (const event of adapter.startUserMessage("hi")) store.append("waiting", event);
    store.setCliSession("waiting", { harness: "codex", id: "test-session" });
    const host = createPiRuntimeController({ cwd: dataDir, dataDir });
    const events = host.getConversation("waiting")!.events;
    assert.equal(events.at(-1)?.type, "run.finished");
    assert.equal((events.at(-1)?.payload as { status?: string }).status, "cancelled");
    host.dispose();
    const restarted = createPiRuntimeController({ cwd: dataDir, dataDir });
    assert.equal(restarted.getConversation("waiting")!.events.length, events.length, "restart is idempotent");
    restarted.dispose();
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

test("HTTP prompt rejections deliver the rejected message and error without touching active runs", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-rejection-"));
  const { factory, release, aborted } = fakeBridges();
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/prompt`;
  const runs: Promise<void>[] = [];
  try {
    const previous = host.controller.runPrompt({ conversationId: "idle", prompt: "old" }, () => {});
    await tick();
    release.get("idle")!();
    await previous;
    for (const conversationId of ["a", "b", "c"]) runs.push(host.controller.runPrompt({ conversationId, prompt: "active" }, () => {}));
    await tick();
    for (const conversationId of ["idle", "a"]) {
      const before = host.controller.getConversation(conversationId)!.events.length;
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, prompt: "rejected prompt", requestId: "rejected-request" }),
      });
      assert.equal(response.status, 200, "the stream headers were already sent");
      const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(events.at(-1)?.type, "run.error");
      assert.equal(events.at(-1)?.runId, "rejected-request");
      assert.equal(events.at(-1)?.payload.code, "prompt_rejected", "the browser keeps the draft only for rejections");
      assert.ok(events.some((event) => event.type === "text.delta" && event.payload.delta === "rejected prompt"));
      assert.equal(host.controller.getConversation(conversationId)!.events.length, before, "rejection must not corrupt another run");
    }
    assert.deepEqual(aborted, []);
    assert.equal(host.controller.listConversations().filter((entry) => entry.running).length, 3);
  } finally {
    for (const finish of release.values()) finish();
    await Promise.all(runs);
    host.dispose();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("accepted submissions keep their request ID in saved history, including bridge startup failure", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-request-id-"));
  const { factory, release } = fakeBridges();
  const host = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: async (input) => {
    if (input.sessionDir?.endsWith("failed")) throw new Error("Bridge failed to start");
    return factory(input);
  } });
  try {
    const run = host.runPrompt({ conversationId: "ok", prompt: "hi", requestId: "accepted-id" }, () => {});
    await tick();
    release.get("ok")!();
    await run;
    assert.ok(host.getConversation("ok")!.events.some((event) => event.type === "run.finished" && event.runId === "accepted-id"));
    await host.runPrompt({ conversationId: "failed", prompt: "show my failed message", requestId: "failed-id" }, () => {});
    const failed = host.getConversation("failed")!.events;
    assert.equal(failed.at(-1)?.type, "run.error");
    assert.equal(failed.at(-1)?.runId, "failed-id");
    assert.notEqual((failed.at(-1)?.payload as { code?: string }).code, "prompt_rejected", "a saved failure clears the draft");
    assert.ok(failed.some((event) => event.type === "text.delta" && (event.payload as { delta?: string }).delta === "show my failed message"));
  } finally {
    host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Pi SDK abort errors settle as cancellation with one terminal event", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-stop-"));
  let emit: (event: any) => void = () => undefined;
  let release!: () => void;
  const factory: PiBridgeFactory = async () => ({
    subscribe(listener) { emit = listener; return () => { emit = () => undefined; }; },
    async prompt() { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("This operation was aborted"); },
    async abort() {
      // The real SDK settles its aborted model request before abort() resolves.
      emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" } });
      emit({ type: "agent_settled" });
      release();
    },
    dispose: () => undefined,
    configure: async () => undefined,
    state: async () => ({ models: [], tools: [] }) as never,
    newSession: async () => undefined,
  });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: factory });
  const events: any[] = [];
  try {
    const running = controller.runPrompt({ conversationId: "stop", prompt: "sleep" }, (event) => events.push(event));
    await tick();
    await controller.abort("stop");
    await running;
    assert.deepEqual(events.filter((event) => ["run.finished", "run.error"].includes(event.type)).map((event) => ({ type: event.type, status: event.payload.status })), [{ type: "run.finished", status: "cancelled" }]);
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("run duration and output limits stop the engine and persist one visible failure", async () => {
  for (const limit of ["duration", "output"]) {
    const root = mkdtempSync(join(tmpdir(), "rtb-limits-"));
    const { factory, release, aborted } = streamingBridges();
    const controller = createPiRuntimeController({
      cwd: root, dataDir: join(root, "data"), bridgeFactory: factory,
      limits: { durationMs: limit === "duration" ? 30 : 1000, outputBytes: limit === "output" ? 900 : 1_000_000, modelRequests: 100 },
    });
    try {
      const running = controller.runPrompt({ conversationId: "limited", prompt: "do work" }, () => {});
      // Keep the event loop alive while the host's unref'ed production deadline expires.
      const guard = setTimeout(() => release.get("limited")?.(), 500);
      assert.equal(controller.health().activeRuns, 1);
      await running;
      clearTimeout(guard);
      assert.deepEqual(aborted, ["limited"]);
      assert.equal(controller.health().activeRuns, 0);
      const events = controller.getConversation("limited")!.events;
      assert.deepEqual(events.filter((event) => event.type === "run.error" || event.type === "run.finished").map((event) => event.type), ["run.error"]);
      assert.match(JSON.stringify(events.at(-1)), /maximum/);
    } finally {
      controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("health is cheap, same-origin guarded, and does not initialize a model session", async () => {
  const { createServer } = await import("node:http");
  const { createPiHttpHost } = await import("./piHost.ts");
  const root = mkdtempSync(join(tmpdir(), "rtb-health-"));
  let bridgeCalls = 0;
  const host = createPiHttpHost({ cwd: root, dataDir: join(root, "data"), bridgeFactory: async () => { bridgeCalls++; throw Error("unused"); } });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/health`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(await response.json()).sort(), ["activeRuns", "maxConcurrentRuns", "status", "uptimeSeconds"]);
    assert.equal(bridgeCalls, 0);
    assert.equal((await fetch(url, { headers: { origin: "https://foreign.example" } })).status, 403);
  } finally {
    host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("synchronous engine completion cannot turn an exceeded output budget into success", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-sync-limit-"));
  let emit: (event: any) => void = () => {};
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"),
    limits: { durationMs: 1000, outputBytes: 2000, modelRequests: 100 },
    bridgeFactory: async () => ({
      subscribe(listener) { emit = listener; return () => {}; },
      async prompt() {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(3000) } });
        emit({ type: "agent_settled" });
      },
      abort: async () => {}, dispose() {}, configure: async () => {}, newSession: async () => {},
      state: async () => ({ models: [], tools: [] }) as never,
    }),
  });
  try {
    await controller.runPrompt({ conversationId: "a", prompt: "hello" }, () => {});
    const terminals = controller.getConversation("a")!.events.filter((event) => ["run.error", "run.finished"].includes(event.type));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].type, "run.error");
    assert.match(JSON.stringify(terminals[0]), /maximum event output/);
  } finally {
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
