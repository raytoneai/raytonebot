import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { abortPiRun, followPiTurn, getArtifactVersions, piArtifactVersionDownloadUrl, PiRequestError, resolvePiApproval, submitPiApproval, runPiTurn } from "./piClient.ts";

test("artifact version metadata and exact download URLs preserve conversation and projected identity", async () => {
  const calls: string[] = [];
  const response = { versions: [{ versionId: "v-a", artifactId: "builder~published_version_11111111-1111-1111-1111-111111111111", createdAt: 1, size: 3, sha256: "hash" }], selectedVersionId: "v-a" };
  const loaded = await getArtifactVersions("chat id", "builder~published_version_11111111-1111-1111-1111-111111111111", async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, undefined);
    return Response.json(response);
  });
  assert.deepEqual(loaded, response);
  const query = new URL(calls[0], "http://test").searchParams;
  assert.equal(query.get("conversationId"), "chat id");
  assert.equal(query.get("artifactId"), "builder~published_version_11111111-1111-1111-1111-111111111111");
  const download = new URL(piArtifactVersionDownloadUrl("chat id", response.versions[0].artifactId, response.versions[0].versionId), "http://test");
  assert.equal(download.searchParams.get("conversationId"), "chat id");
  assert.equal(download.searchParams.get("artifactId"), response.versions[0].artifactId);
  assert.equal(download.searchParams.get("versionId"), "v-a");
});

test("approval delivery checks the exact request after losing a receipt and only resends while still pending", async () => {
  for (const pending of [false, true]) {
    const calls: string[] = [];
    const input = { toolCallId: "tool", decision: "no" as const, conversationId: "conversation", runId: "run" };
    await submitPiApproval(input, { fetcher: async (url, init) => {
      calls.push(init?.method ?? "GET");
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      if (!init?.method) {
        const query = new URL(String(url), "http://test").searchParams;
        assert.deepEqual(Object.fromEntries(query), { toolCallId: "tool", conversationId: "conversation", runId: "run" });
        return Response.json({ pending });
      }
      assert.deepEqual(JSON.parse(init.body as string), input);
      return Response.json({ ok: true });
    } });
    assert.deepEqual(calls, pending ? ["POST", "GET", "POST"] : ["POST", "GET"]);
  }
});

test("leaving an approval stops delivery even if a pending-status response arrives late", async () => {
  const controller = new AbortController(), methods: string[] = [];
  await assert.rejects(submitPiApproval({ toolCallId: "tool", decision: "yes", conversationId: "chat", runId: "run" }, {
    signal: controller.signal,
    fetcher: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      if (methods.length === 1) return Response.json({ error: "Disconnected" }, { status: 503 });
      controller.abort(new Error("left approval"));
      return Response.json({ pending: true });
    },
  }), /left approval/);
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("stop sends the observed run identity and does not retry a stale rejection", async () => {
  let calls = 0;
  await assert.rejects(abortPiRun("conversation", async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init!.body as string), { conversationId: "conversation", runId: "observed-run" });
    assert.ok(init!.signal);
    return Response.json({ error: "stale run" }, { status: 409 });
  }, "observed-run"), (error: unknown) => error instanceof PiRequestError && error.status === 409);
  assert.equal(calls, 1);
});

test("approval has a deadline without retrying an uncertain decision", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    assert.equal(duration, 15_000);
    return controller.signal;
  });
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init!.body as string), { toolCallId: "tool", decision: "yes", conversationId: "conversation", runId: "run" });
    assert.equal(init!.signal, controller.signal);
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  };
  const rejected = assert.rejects(resolvePiApproval("tool", "yes", "conversation", "run", fetcher), /deadline/);
  controller.abort(new Error("deadline"));
  await rejected;
  assert.equal(calls, 1);
});

test("approval distinguishes accepted or stale decisions from retryable transport failures", async () => {
  assert.equal(await resolvePiApproval("tool", "no", "conversation", "run", async () => Response.json({ ok: true })), true);
  await assert.rejects(resolvePiApproval("tool", "no", "conversation", "run", async () => Response.json({})), /acknowledgement/);
  assert.equal(await resolvePiApproval("tool", "no", "conversation", "run", async () => Response.json({}, { status: 409 })), false);
  await assert.rejects(resolvePiApproval("tool", "no", "conversation", "run", async () => Response.json({ error: "offline" }, { status: 503 })),
    (error: unknown) => error instanceof PiRequestError && error.status === 503 && error.message === "offline");
  await assert.rejects(resolvePiApproval("tool", "no", "conversation", "run", async () => { throw new TypeError("Failed to fetch"); }),
    (error: unknown) => error instanceof PiRequestError && error.status === 0 && error.message === "Failed to fetch");
});

test("invalid prompt HTTP errors are distinguishable from a dropped connection", async () => {
  const fetcher: typeof fetch = async () => Response.json({ error: "Pi prompt is required." }, { status: 400 });
  await assert.rejects(async () => {
    for await (const _event of runPiTurn({ prompt: "next turn" }, { fetcher })) { /* drain */ }
  }, (error: unknown) => error instanceof PiRequestError && error.status === 400 && error.message === "Pi prompt is required.");
});

test("reattachment cannot silently accept an older turn for a lost submission", async () => {
  const previous = { type: "run.finished", runId: "old-request", payload: { status: "success" } };
  for (const live of [false, true]) {
    const fetcher: typeof fetch = async (url) => String(url).includes("/live?")
      ? live ? new Response(JSON.stringify(previous) + "\n") : Response.json({}, { status: 409 })
      : Response.json({ id: "a", events: [previous] });
    await assert.rejects(async () => {
      for await (const _event of followPiTurn("a", 1, { fetcher, requestId: "new-request" })) { /* drain */ }
    }, (error: unknown) => error instanceof PiRequestError && error.status === 409);
  }
});

test("a submission accepted before losing its response is identified in saved history", async () => {
  const event = { type: "run.finished", runId: "this-request", payload: { status: "success" } };
  const fetcher: typeof fetch = async (url) => String(url).includes("/live?")
    ? Response.json({}, { status: 409 }) : Response.json({ id: "a", events: [event] });
  const received = [];
  for await (const value of followPiTurn("a", 0, { fetcher, requestId: "this-request" })) received.push(value);
  assert.deepEqual(received, [event]);
});

test("an unresponsive live stream times out so reattachment can consume its retry budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = followPiTurn("a", 0, { fetcher }).next();
  const rejected = assert.rejects(pending, /timed out/i);
  await setImmediate();
  t.mock.timers.tick(15_001);
  await rejected;
  assert.equal(cancelled, true, "timed out readers release the connection");
});

test("heartbeats keep a quiet long-running turn connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const iterator = followPiTurn("a", 0, { fetcher });
  const next = iterator.next();
  await setImmediate();
  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(5_000);
    stream.enqueue(encoder.encode("\n"));
    await setImmediate();
  }
  stream.enqueue(encoder.encode(JSON.stringify({ type: "run.finished", payload: { status: "success" } }) + "\n"));
  stream.close();
  assert.equal((await next).value?.type, "run.finished");
  assert.equal((await iterator.next()).done, true);
});

test("a stalled live connection handshake has a deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
  const rejected = assert.rejects(followPiTurn("a", 0, { fetcher }).next(), /timed out/i);
  t.mock.timers.tick(15_001);
  await rejected;
});

test("a turn finishing between history and live subscription still delivers its final events", async () => {
  const events = [
    { type: "text.delta", id: "old", seq: 1, payload: { delta: "partial" } },
    { type: "text.delta", id: "new", seq: 2, payload: { delta: " final answer" } },
    { type: "run.finished", id: "done", seq: 3, payload: { status: "success" } },
  ] as AgentUXEvent[];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes("/live?")
      ? Response.json({ error: "No run in progress" }, { status: 409 })
      : Response.json({ id: "a", events });
  };
  const received = [];
  for await (const event of followPiTurn("a", 1, { fetcher })) received.push(event);
  assert.deepEqual(received, events.slice(1));
  assert.equal(calls.length, 2);
  const caughtUp = [];
  for await (const event of followPiTurn("a", 3, { fetcher })) caughtUp.push(event);
  assert.deepEqual(caughtUp, [], "already received events are not duplicated");
});
