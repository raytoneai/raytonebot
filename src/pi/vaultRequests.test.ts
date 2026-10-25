import assert from "node:assert/strict";
import { test } from "node:test";
import { VaultRequestError, VaultRequestGate } from "./vaultRequests.ts";
import type { VaultRequestAnswer, VaultRequestView } from "./vaultRequestTypes.ts";

function setup(execute: (answer: VaultRequestAnswer) => Promise<{ status: "filled" }>, signal?: AbortSignal, expiresAt = Date.now() + 5000) {
  const gate = new VaultRequestGate(); let view!: VaultRequestView;
  const waiting = gate.wait({ conversationId: "c", runId: "r", origin: "https://example.com", items: [{ id: "saved", label: "Work" }], expiresAt, signal, announce: v => { view = v; }, execute });
  const answer = (value: unknown) => gate.answer("c", view.requestId, "r", value);
  return { gate, view, waiting, answer };
}
const login = { action: "fill", username: " 帳号 ", password: " 密碼 🔑 ", save: false };

test("Secure request validates shape and limits without trimming or retaining secret answers", async () => {
  let received: VaultRequestAnswer | undefined;
  const f = setup(async answer => { received = answer; return { status: "filled" }; });
  for (const value of [null, {}, { ...login, save: undefined }, { ...login, password: "" }, { ...login, username: "x".repeat(513) }, { ...login, password: "x".repeat(8193) }, { ...login, url: "https://evil.example" }, { ...login, id: "old" }, { action: "cancel", password: "secret" }, { action: "use", itemId: "wrong" }]) {
    await assert.rejects(f.answer(value), VaultRequestError); assert.equal(f.gate.waitingIn("c"), true);
  }
  await assert.rejects(f.gate.answer("c", f.view.requestId, "other", login), VaultRequestError);
  assert.ok(!JSON.stringify(f.gate.pendingIn("c")).includes(login.password));
  assert.equal((await f.answer(login)).status, "filled"); await f.waiting;
  assert.deepEqual(received, login); assert.equal(f.gate.waitingIn("c"), false);
});

test("Concurrent submissions and receipt retries execute once; recoverable save failure permits explicit retry", async () => {
  let release!: () => void, calls = 0;
  const f = setup(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return { status: "filled" }; });
  const first = f.answer(login), second = f.answer(login);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
  assert.deepEqual(await first, await second); await f.waiting;
  await f.answer(login); assert.equal(calls, 1);
  let attempt = 0;
  const retry = setup(async () => { if (++attempt === 1) throw new VaultRequestError("Login could not be saved.", 409); return { status: "filled" }; });
  await assert.rejects(retry.answer(login), VaultRequestError);
  assert.equal(retry.gate.waitingIn("c"), true);
  assert.equal((await retry.answer(login)).status, "filled"); await retry.waiting; assert.equal(attempt, 2);
});

test("Cancel, abort and expiration are terminal and late answers cannot revive requests", async () => {
  for (const action of ["cancel", "abort", "expire"] as const) {
    let calls = 0; const abort = new AbortController();
    const f = setup(async () => { calls++; return { status: "filled" }; }, abort.signal, Date.now() + (action === "expire" ? 10 : 2000));
    if (action === "cancel") await f.answer({ action: "cancel" });
    else if (action === "abort") abort.abort();
    else await new Promise(resolve => setTimeout(resolve, 20));
    const result = await f.waiting;
    assert.equal(result.status, action === "cancel" ? "denied" : "expired");
    assert.deepEqual(await f.answer(login), result); assert.equal(calls, 0);
  }
});


test("Stop and expiry settle in-flight requests immediately and late execution cannot revive them", async () => {
  for (const interruption of ["stop", "expiry"] as const) {
    let release!: () => void;
    const abort = new AbortController();
    const f = setup(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: "filled" }; }, abort.signal, Date.now() + (interruption === "expiry" ? 10 : 2000));
    const submission = f.answer(login);
    await new Promise(resolve => setImmediate(resolve));
    if (interruption === "stop") abort.abort();
    else await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await f.waiting).status, "expired");
    assert.equal(f.gate.waitingIn("c"), false);
    release(); assert.equal((await submission).status, "expired");
    assert.equal((await f.answer(login)).status, "expired");
  }
});
