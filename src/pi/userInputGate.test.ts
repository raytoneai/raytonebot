import test from "node:test";
import assert from "node:assert/strict";
import { UserInputGate } from "./userInputGate.ts";
import { pendingUserInput, userQuestions, type PendingUserInput } from "../runtime/userInput.ts";

test("user questions require actual answers, preserve choice semantics, and cannot cross conversations or survive cancellation", async () => {
  const gate = new UserInputGate(), abort = new AbortController();
  const questions = userQuestions([{ question: "Choose", header: "Scope", options: [{ label: "A" }, { label: "B" }], multiSelect: true }], "claude");
  let request!: PendingUserInput;
  const waiting = gate.wait("one", "tool", questions, abort.signal, (value) => { request = value; });
  assert.equal(gate.resolve("two", request.requestId, { q0: ["A"] }), false);
  assert.throws(() => gate.resolve("one", request.requestId, {}));
  assert.equal(gate.resolve("one", request.requestId, { q0: ["A", "自由回答"] }), true);
  assert.deepEqual(await waiting, { q0: ["A", "自由回答"] });
  assert.equal(gate.resolve("one", request.requestId, { q0: ["A", "自由回答"] }), true);
  assert.equal(gate.resolve("one", request.requestId, null), false);
  const stopped = gate.wait("one", "next", questions, abort.signal, (value) => { request = value; });
  abort.abort();
  assert.equal(gate.resolve("one", request.requestId, { q0: ["A"] }), false);
  await assert.rejects(stopped, /cancelled/);
  assert.equal(gate.resolve("one", request.requestId, { q0: ["A"] }), false);
  const event = { type: "run.awaiting_input", payload: request };
  assert.deepEqual(pendingUserInput([event]), request);
  assert.equal(pendingUserInput([event, { type: "tool.call.progress", payload: { inputRequestId: request.requestId } }]), undefined);
  assert.equal(pendingUserInput([event, { type: "run.finished", payload: {} }]), undefined);
  assert.throws(() => userQuestions([{ question: "Password", isSecret: true }], "codex"));
});
