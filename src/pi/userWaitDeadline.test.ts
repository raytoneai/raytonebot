import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import type { UserQuestion } from "../runtime/userInput.ts";

const questions: UserQuestion[] = [{ id: "choice", header: "Choice", question: "Which option?",
  options: [{ label: "A", description: "First option" }, { label: "B", description: "Second option" }], multiSelect: false, allowOther: true }];
const day = 24 * 60 * 60 * 1000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function stopped(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function host(t: TestContext, prompt: (input: Parameters<PiBridgeFactory>[0], signal: AbortSignal, id: string) => Promise<void>) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const root = mkdtempSync(join(tmpdir(), "rtb-user-wait-budget-"));
  const events = new Map<string, AgentUXEvent[]>();
  const controller = createPiRuntimeController({ cwd: root, dataDir: join(root, "data"),
    limits: { durationMs: 1000, outputBytes: 1_000_000, modelRequests: 100 },
    bridgeFactory: async input => {
      let run = new AbortController();
      const id = decodeURIComponent(input.sessionDir!.split("/").at(-1)!);
      return { subscribe: () => () => {},
        prompt: async () => { run = new AbortController(); await prompt(input, run.signal, id); },
        abort: async () => { run.abort(); }, dispose() {}, configure: async () => {},
        state: async () => ({ models: [], tools: [] }), newSession: async () => {},
      };
    },
  });
  const errors = (id = "waiting") => (events.get(id) ?? []).filter(event => event.type === "run.error");
  const requestId = (id = "waiting") => {
    const request = [...(events.get(id) ?? [])].reverse().find(event => event.type === "run.awaiting_input" && event.payload.requestId);
    assert.ok(request, "the current question must have been published");
    return String(request.payload.requestId);
  };
  const run = (id = "waiting") => {
    events.set(id, []);
    return controller.runPrompt({ conversationId: id, prompt: "Controlled question timing" }, event => events.get(id)!.push(event));
  };
  return { controller, run, errors, requestId,
    async close() { await controller.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

for (const answer of ["answer", "skip", "cancel"] as const) {
  test(`ordinary question ${answer} resumes only the remaining execution budget`, async t => {
    const ready = deferred(), continued = deferred();
    const cancelQuestion = new AbortController();
    const h = host(t, async ({ onUserInput }, signal) => {
      t.mock.timers.tick(400);
      const waiting = onUserInput({ toolCallId: "question", questions, signal: AbortSignal.any([signal, cancelQuestion.signal]) });
      ready.resolve();
      if (answer === "cancel") await assert.rejects(waiting, /cancelled/);
      else await waiting;
      continued.resolve();
      await stopped(signal);
    });
    const running = h.run();
    try {
      await ready.promise;
      t.mock.timers.tick(day);
      assert.deepEqual(h.errors(), [], "human waiting does not exhaust the execution budget");
      assert.equal(h.controller.awaitingUser("waiting"), true);
      const id = h.requestId();
      if (answer === "cancel") cancelQuestion.abort();
      else assert.equal(h.controller.resolveUserInput("waiting", id, answer === "skip" ? null : { choice: ["A"] }), true);
      await continued.promise;
      assert.equal(h.controller.awaitingUser("waiting"), false);
      t.mock.timers.tick(599);
      assert.deepEqual(h.errors(), []);
      t.mock.timers.tick(1);
      await running;
      assert.equal(h.errors().length, 1);
      assert.match(JSON.stringify(h.errors()[0]), /reached its time limit/);
    } finally { await h.close(); await running; }
  });
}

for (const first of ["approval", "question"] as const) {
  test(`${first} completing first does not resume a run still waiting on the other human decision`, async t => {
    const ready = deferred(), continued = deferred();
    let approval!: Promise<void>;
    let question!: Promise<unknown>;
    const h = host(t, async ({ approvalGate, onUserInput }, signal) => {
      t.mock.timers.tick(400);
      approval = approvalGate.wait("approval", "write", { path: "notes.md" }, signal);
      question = onUserInput({ toolCallId: "question", questions, signal });
      ready.resolve();
      await Promise.all([approval, question]);
      continued.resolve();
      await stopped(signal);
    });
    const running = h.run();
    const decide = async (kind: typeof first) => {
      if (kind === "approval") {
        assert.equal(h.controller.resolveApproval("approval", "yes", "waiting"), true);
        await approval;
      } else {
        assert.equal(h.controller.resolveUserInput("waiting", h.requestId(), { choice: ["A"] }), true);
        await question;
      }
    };
    try {
      await ready.promise;
      t.mock.timers.tick(day);
      assert.deepEqual(h.errors(), []);
      await decide(first);
      t.mock.timers.tick(day);
      assert.deepEqual(h.errors(), [], "the unresolved decision still pauses this run");
      assert.equal(h.controller.awaitingUser("waiting"), true);
      await decide(first === "approval" ? "question" : "approval");
      await continued.promise;
      assert.equal(h.controller.awaitingUser("waiting"), false);
      t.mock.timers.tick(599);
      assert.deepEqual(h.errors(), []);
      t.mock.timers.tick(1);
      await running;
      assert.equal(h.errors().length, 1);
    } finally { await h.close(); await running; }
  });
}

test("stopping a question clears it and a late answer cannot resume the next run's wait", async t => {
  let ready = deferred();
  const h = host(t, async ({ onUserInput }, signal) => {
    const answer = onUserInput({ toolCallId: "question", questions, signal });
    ready.resolve();
    await answer;
  });
  let running = h.run();
  try {
    await ready.promise;
    const oldRequest = h.requestId();
    await h.controller.abort("waiting"); await running;
    assert.equal(h.controller.awaitingUser("waiting"), false);
    ready = deferred(); running = h.run(); await ready.promise;
    assert.notEqual(h.requestId(), oldRequest);
    assert.equal(h.controller.resolveUserInput("waiting", oldRequest, { choice: ["A"] }), false);
    t.mock.timers.tick(day);
    assert.deepEqual(h.errors(), []);
    assert.equal(h.controller.awaitingUser("waiting"), true);
    assert.equal(h.controller.resolveUserInput("waiting", h.requestId(), { choice: ["B"] }), true);
    await running;
    assert.equal(h.controller.awaitingUser("waiting"), false);
  } finally { await h.close(); await running; }
});

test("one conversation's question does not pause a different conversation's execution", async t => {
  const waitingReady = deferred(), workingReady = deferred();
  const h = host(t, async ({ onUserInput }, signal, id) => {
    if (id === "waiting") {
      const answer = onUserInput({ toolCallId: "question", questions, signal });
      waitingReady.resolve();
      await answer;
    } else workingReady.resolve();
    await stopped(signal);
  });
  const waiting = h.run(), working = h.run("working");
  try {
    await Promise.all([waitingReady.promise, workingReady.promise]);
    t.mock.timers.tick(1000);
    await working;
    assert.equal(h.errors("working").length, 1);
    assert.deepEqual(h.errors(), []);
    assert.equal(h.controller.awaitingUser("waiting"), true);
  } finally { await h.close(); await Promise.all([waiting, working]); }
});
