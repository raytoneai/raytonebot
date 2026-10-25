import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { VaultRequestAnswer, VaultRequestView, VaultUseResult } from "../pi/vaultRequestTypes.ts";
import { createVaultRequestDraft, pendingVaultRequest } from "./vaultRequest.ts";

const request = (change: Partial<VaultRequestView> = {}): VaultRequestView => ({ requestId: "request", runId: "run", origin: "https://example.com", expiresAt: Date.now() + 120_000, items: [], ...change });
const event = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload }) as AgentUXEvent;
const fillDraft = () => { const draft = createVaultRequestDraft(request()); draft.edit({ username: " 用户 name ", password: "  p\t密碼 🔒  " }); return draft; };

test("Vault request metadata resolves on its own receipt and every terminal or new run", () => {
  const first = request(), second = request({ requestId: "second" });
  const events = [event("run.awaiting_input", { vaultRequest: first }), event("run.awaiting_input", { questions: [] }), event("run.awaiting_input", { vaultRequest: second })];
  assert.equal(pendingVaultRequest(events), second);
  assert.equal(pendingVaultRequest([...events, event("tool.call.progress", { inputRequestId: "second" })]), first);
  for (const type of ["run.started", "run.finished", "run.error"]) assert.equal(pendingVaultRequest([...events, event(type)]), undefined);
});

test("independent secret fields preserve whitespace and Unicode and save is opt-in", async () => {
  const draft = fillDraft();
  assert.equal(draft.state.save, false);
  let answer: VaultRequestAnswer | undefined;
  await draft.submit(false, async value => { answer = value; return { status: "filled" }; });
  assert.deepEqual(answer, { action: "fill", username: " 用户 name ", password: "  p\t密碼 🔒  ", save: false });
  assert.equal(draft.state.username, ""); assert.equal(draft.state.password, "");
  assert.deepEqual(draft.state.result, { status: "filled", saved: undefined });
});

test("saved login selection only sends the selected id, new login saving uses the user's choice", async () => {
  const saved = createVaultRequestDraft(request({ items: [{ id: "item", label: "Work" }] }));
  let answer: VaultRequestAnswer | undefined;
  await saved.submit(false, async value => { answer = value; return { status: "filled" }; });
  assert.deepEqual(answer, { action: "use", itemId: "item" });
  const fresh = fillDraft(); fresh.edit({ save: true, label: " Personal " });
  await fresh.submit(false, async value => { answer = value; return { status: "unknown", saved: true, message: "untrusted secret" }; });
  assert.deepEqual(answer, { action: "fill", username: " 用户 name ", password: "  p\t密碼 🔒  ", save: true, label: "Personal" });
  assert.deepEqual(fresh.state.result, { status: "unknown", saved: true });
  assert.doesNotMatch(JSON.stringify(fresh.state), /untrusted secret/);
});

test("synchronous duplicate submits fill once and uncertain results cannot be replayed", async () => {
  const draft = fillDraft(); let calls = 0;
  let finish!: (result: VaultUseResult) => void;
  const send = () => { calls++; return new Promise<VaultUseResult>(resolve => { finish = resolve; }); };
  const pending = draft.submit(false, send);
  await draft.submit(false, send); assert.equal(calls, 1); assert.equal(draft.state.pending, true);
  draft.edit({ password: "must not change" }); assert.equal(draft.state.password, "  p\t密碼 🔒  ");
  finish({ status: "unknown" }); await pending;
  await draft.submit(false, send); assert.equal(calls, 1);
});

test("HTTP failure keeps this draft for an explicit retry without exposing error text", async () => {
  const draft = fillDraft();
  await draft.submit(false, async () => { throw new Error("echoed secret"); });
  assert.equal(draft.state.failed, true); assert.equal(draft.state.pending, false);
  assert.equal(draft.state.password, "  p\t密碼 🔒  ");
  assert.doesNotMatch(JSON.stringify(draft.state), /echoed secret/);
  await draft.submit(false, async () => ({ status: "filled" }));
  assert.equal(draft.state.password, "");
});

test("request or conversation disposal clears secrets and ignores late HTTP completion", async () => {
  const old = fillDraft(); let finish!: (result: VaultUseResult) => void; let redraws = 0;
  old.listen(() => { redraws++; });
  const pending = old.submit(false, () => new Promise(resolve => { finish = resolve; }));
  old.dispose(); assert.equal(old.state.username, ""); assert.equal(old.state.password, "");
  const fresh = createVaultRequestDraft(request({ requestId: "new" })); fresh.edit({ username: "new user", password: "new password" });
  finish({ status: "filled" }); await pending;
  assert.equal(old.state.result, undefined); assert.equal(redraws, 1);
  assert.equal(fresh.state.password, "new password"); assert.equal(fresh.state.result, undefined);
  assert.equal(createVaultRequestDraft(request()).state.password, "", "refresh never restores secret drafts");
});

test("cancel and expiry clear secrets, and an expired request cannot be posted", async () => {
  const canceled = fillDraft(); let answer: VaultRequestAnswer | undefined;
  await canceled.submit(true, async value => { answer = value; assert.equal(canceled.state.password, ""); return { status: "denied" }; });
  assert.deepEqual(answer, { action: "cancel" }); assert.equal(canceled.state.dismissed, true);
  const expired = createVaultRequestDraft(request({ expiresAt: 1 })); expired.edit({ username: "user", password: "secret" });
  await expired.submit(false, async () => { assert.fail("expired request must not be posted"); });
  assert.equal(expired.state.password, ""); assert.equal(expired.state.result?.status, "expired");
});

test("credential limits allow 8192-character passwords without the ordinary question limit", async () => {
  const draft = createVaultRequestDraft(request()); draft.edit({ username: "u".repeat(512), password: "p".repeat(8192) });
  let calls = 0; await draft.submit(false, async () => { calls++; return { status: "filled" }; }); assert.equal(calls, 1);
  const invalid = createVaultRequestDraft(request()); invalid.edit({ username: "u".repeat(513), password: "p" });
  await invalid.submit(false, async () => { assert.fail("overlong username must not be posted"); });
});
