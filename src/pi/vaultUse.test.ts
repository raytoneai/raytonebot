import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { VaultStore } from "./vault.ts";
import { vaultToolsFor, type VaultRun } from "./vaultUse.ts";
import { VaultRequestGate, VaultRequestError } from "./vaultRequests.ts";
import type { VaultRequestView, VaultUseResult } from "./vaultRequestTypes.ts";
import { createPiHttpHost } from "./piHost.ts";
import { createBrowserService, findHeadlessShell } from "./browser/browserService.ts";
import { scrubSecretEnv } from "./runtime/childEnv.ts";

const input = { snapshotId: "snapshot", passwordRef: "password", usernameRef: "username" };
const login = { label: "Test login", origin: "https://example.com", username: "private-user-canary", password: " secret-password-canary ", enabled: true };
function fixture(timeoutMs = 1000, empty = false) {
  const store = new VaultStore(); if (!empty) store.save(login, 0);
  const saved = store.view();
  let current: VaultRun | undefined = { botId: "assistant", runId: "run" };
  let pending!: VaultRequestView, count = 0, changed = false, failed = false;
  let receipt: VaultUseResult | undefined, fillWait: Promise<void> | undefined;
  const gate = new VaultRequestGate();
  const tools = vaultToolsFor({ store, conversationId: "chat", timeoutMs, currentRun: () => current,
    requests: gate, announce: (_id, request) => { pending = request; }, resolved(_id, _request, result) { receipt = result; },
    browser: {
      async captureLoginTarget() { return { ...input, conversationId: "chat", pageId: "page", origin: login.origin, controlEpoch: 1, token: "token" }; },
      async validateLoginTarget() { if (changed) throw new Error("Page changed"); },
      async fillLogin(_target, credentials, _signal, validate) { validate?.(); assert.equal(credentials.password, login.password); count++; if (fillWait) await fillWait; validate?.(); if (failed) throw new Error(login.password); },
    },
  });
  const wait = async () => { while (!pending) await new Promise(resolve => setImmediate(resolve)); return pending; };
  const approve = () => gate.answer("chat", pending.requestId, pending.runId, { action: "use", itemId: saved.items[0].id });
  const fill = (save = false) => gate.answer("chat", pending.requestId, pending.runId, { action: "fill", username: login.username, password: login.password, save });
  return { store, saved, tools, wait, approve, fill, gate, receipt: () => receipt, holdFill: () => { let release!: () => void; fillWait = new Promise<void>(resolve => { release = resolve; }); return release; }, count: () => count, navigate: () => { changed = true; }, failFill: () => { failed = true; }, changeRun: (run?: VaultRun) => { current = run; } };
}

test("Vault use requires scoped input; denial, stop, expiry, changed item/run/page never fill", async () => {
  for (const action of ["allow", "deny", "abort", "host-stop", "timeout", "edit", "delete", "disable", "new-run", "other-bot", "navigate"] as const) {
    const f = fixture(action === "timeout" ? 20 : 2000), abort = new AbortController();
    const hostStop = new AbortController();
    f.changeRun({ botId: "assistant", runId: "run", signal: hostStop.signal });
    const run = f.tools.run("vault_request_use", input, abort.signal);
    const pending = await f.wait();
    const events = JSON.stringify(pending);
    assert.ok(!events.includes(login.password) && !events.includes(login.username));
    assert.equal(f.count(), 0);
    await assert.rejects(f.gate.answer("other", pending.requestId, pending.runId, { action: "cancel" }), VaultRequestError);
    await assert.rejects(f.gate.answer("chat", pending.requestId, pending.runId, { action: "use", itemId: "invented" }), VaultRequestError);
    if (action === "allow") await f.approve();
    else if (action === "deny") await f.gate.answer("chat", pending.requestId, pending.runId, { action: "cancel" });
    else if (action === "abort") abort.abort();
    else if (action === "host-stop") hostStop.abort();
    else if (action === "timeout") await new Promise(resolve => setTimeout(resolve, 35));
    else {
      if (action === "edit") f.store.save({ ...login, id: f.saved.items[0].id, password: "replacement" }, 1);
      if (action === "delete") f.store.remove(f.saved.items[0].id, 1);
      if (action === "disable") f.store.save({ ...login, id: f.saved.items[0].id, enabled: false }, 1);
      if (action === "new-run") f.changeRun({ botId: "assistant", runId: "later" });
      if (action === "other-bot") f.changeRun({ botId: "other", runId: "run" });
      if (action === "navigate") f.navigate();
      await f.approve();
    }
    const result = await run;
    assert.equal(f.count(), action === "allow" ? 1 : 0, action);
    assert.ok(!result.text.includes(login.password));
    if (action === "allow") { await f.approve(); assert.equal(f.count(), 1, "receipt replay is not another fill"); }
  }
});

test("New secure input supports no-save and save; page changes prevent saving and failed saves remain retryable", async () => {
  for (const save of [false, true]) {
    const f = fixture(2000, true), run = f.tools.run("vault_request_use", input);
    assert.deepEqual((await f.wait()).items, []);
    const result = await f.fill(save); await run;
    assert.equal(result.status, "filled"); assert.equal(result.saved, save);
    assert.equal(f.store.view().items.length, save ? 1 : 0);
    if (save) { const item = f.store.view().items[0]; assert.equal(f.store.resolve(item.id, item.version, login.origin).password, login.password); }
    await f.fill(save); assert.equal(f.count(), 1); assert.equal(f.store.view().items.length, save ? 1 : 0);
  }
  const changed = fixture(2000, true), changedRun = changed.tools.run("vault_request_use", input);
  await changed.wait(); changed.navigate(); assert.equal((await changed.fill(true)).status, "expired"); await changedRun;
  assert.equal(changed.store.view().items.length, 0);
  const failed = fixture(2000, true), failedRun = failed.tools.run("vault_request_use", input);
  await failed.wait(); const original = failed.store.save; failed.store.save = () => { throw new Error(login.password); };
  await assert.rejects(failed.fill(true), error => error instanceof VaultRequestError && !error.message.includes(login.password));
  assert.equal(failed.gate.waitingIn("chat"), true); assert.equal(failed.count(), 0);
  failed.store.save = original; await failed.fill(true); await failedRun; assert.equal(failed.store.view().items.length, 1);
});

test("A save error after persistence is terminal and cannot create another login on receipt retry", async () => {
  const f = fixture(2000, true), run = f.tools.run("vault_request_use", input);
  await f.wait(); const original = f.store.save;
  f.store.save = function(input, revision) { original.call(this, input, revision); throw new Error("Post-write failure"); };
  const result = await f.fill(true); await run;
  assert.equal(result.status, "unknown"); assert.equal(result.saved, true);
  assert.equal(f.count(), 0); assert.equal(f.store.view().items.length, 1);
  assert.deepEqual(await f.fill(true), result); assert.equal(f.store.view().items.length, 1);
});

test("Stop during a saved fill immediately reports saved but uncertain, and late completion cannot revive it", async () => {
  const f = fixture(2000, true), abort = new AbortController(), release = f.holdFill();
  const run = f.tools.run("vault_request_use", input, abort.signal); await f.wait();
  const submission = f.fill(true);
  while (f.count() === 0) await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  const result = JSON.parse((await run).text);
  assert.equal(result.status, "unknown"); assert.equal(result.saved, true);
  assert.deepEqual(f.receipt(), result);
  release(); assert.deepEqual(await submission, result);
  assert.deepEqual(await f.fill(true), result); assert.equal(f.store.view().items.length, 1);
});

test("Unknown arguments and IM/group are rejected; saved fill failures are uncertain and never replayed", async () => {
  const f = fixture();
  assert.equal((await f.tools.run("vault_request_use", { ...input, password: login.password })).isError, true);
  for (const flags of [{ fromChannel: true }, { groupConversation: true }]) {
    f.changeRun({ botId: "a", runId: "r", ...flags });
    assert.match((await f.tools.run("vault_request_use", input)).text, /web app/);
  }
  const failing = fixture(2000, true); failing.failFill();
  const run = failing.tools.run("vault_request_use", input); await failing.wait();
  const result = await failing.fill(true); await run;
  assert.equal(result.status, "unknown"); assert.equal(result.saved, true); assert.ok(!JSON.stringify(result).includes(login.password));
  await failing.fill(true); assert.equal(failing.count(), 1); assert.equal(failing.store.view().items.length, 1);
  assert.deepEqual(scrubSecretEnv({ RAYTONEBOT_VAULT_MASTER_KEY: "fake", PATH: "/bin" }), { PATH: "/bin" });
});

test("Settings HTTP save, restart, browser-scoped approval and actual HTTPS fill work end-to-end in every permission mode", { timeout: 90_000, skip: !findHeadlessShell() && "Chromium not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "raytone-vault-integration-"));
  const vaultDir = join(dir, "Vault"), dataDir = join(dir, "data");
  const keyFile = join(dir, "tls.key"), certFile = join(dir, "tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const certificate = readFileSync(certFile);
  const pin = createHash("sha256").update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const seen: string[] = []; let submits = 0;
  const site = httpsServer({ key: readFileSync(keyFile), cert: certificate }, (req, res) => {
    if (req.url?.startsWith("/seen?")) { seen.push(decodeURIComponent(req.url.slice(6))); res.end("ok"); return; }
    if (req.url === "/submit") submits++;
    res.setHeader("content-type", "text/html");
    res.end('<title>Vault test</title><form method="post" action="/submit"><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form><script>for (const id of ["username","password"]) document.getElementById(id).addEventListener("input",e=>fetch("/seen?"+encodeURIComponent(e.target.value)));</script>');
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const sitePort = (site.address() as { port: number }).port;
  const siteOrigin = `https://127.0.0.1:${sitePort}`;
  const browser = createBrowserService({ dataDir, testOnlyCertificateSpki: pin, allowAddress: ip => ip === "127.0.0.1", allowPort: port => port === sitePort });
  const results: string[] = [];
  const start = async () => {
    const host = createPiHttpHost({ cwd: dir, dataDir, vaultDir, routineClock: false, browser,
      bridgeFactory: async ({ hostTools, approvalGate }) => ({
        configure: async () => {}, state: async () => ({ models: [], tools: hostTools!.specs.map(tool => tool.name) }),
        subscribe: () => () => {}, newSession: async () => {}, dispose() {}, abort: async () => {},
        async prompt() {
          assert.equal(approvalGate.requiresApproval("vault_request_use", {}), false, "consent is enforced inside the host tool, not by the mode");
          const opened = await hostTools!.run("browser_open", { url: siteOrigin });
          assert.equal(opened.isError, false, opened.text);
          const args = { snapshotId: /Snapshot: (\S+)/.exec(opened.text)![1],
            usernameRef: /textbox "Username" \[ref=([^\]]+)\]/.exec(opened.text)![1],
            passwordRef: /textbox "Password" \[ref=([^\]]+)\]/.exec(opened.text)![1] };
          results.push((await hostTools!.run("vault_request_use", args)).text);
        },
      }),
    });
    const server = createServer((req, res) => { void host.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { host, origin, close: async () => { host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  };
  let running = await start();
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${running.origin}/__agentcanvas/pi${path}`, {
    method, headers: { "x-raytone-vault": "1", ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("/vault", "POST", { item: { ...login, origin: siteOrigin }, revision: 0 }, { origin: "https://evil.example" })).status, 403);
    const saved = await request("/vault", "POST", { item: { ...login, origin: siteOrigin }, revision: 0 });
    assert.equal(saved.status, 200); assert.equal(saved.headers.get("cache-control"), "no-store");
    const view = await saved.json();
    assert.ok(!JSON.stringify(view).includes(login.password) && !JSON.stringify(view).includes(login.username));
    await running.close(); running = await start();
    assert.equal((await (await request("/vault")).json()).items.length, 1);
    for (const mode of ["request", "auto", "allow-all"] as const) for (const kind of ["saved", "new", "save"] as const) {
      const conversationId = `${mode}-${kind}`;
      const before = await (await request("/vault")).json();
      let pending!: VaultRequestView;
      let announce!: () => void;
      const waiting = new Promise<void>(resolve => { announce = resolve; });
      const turn = running.host.controller.runPrompt({ conversationId, requestId: `vault-${conversationId}`, prompt: "Fill the dummy login", permissionMode: mode }, event => {
        if (event.type === "run.awaiting_input") { pending = (event.payload as { vaultRequest: VaultRequestView }).vaultRequest; announce(); }
      });
      await waiting;
      const answer = { conversationId, runId: pending.runId, answer: kind === "saved" ? { action: "use", itemId: pending.items[0].id } : { action: "fill", username: login.username, password: login.password, save: kind === "save", label: `Login ${mode}` } };
      const answerPath = `/vault/requests/${pending.requestId}/answer`;
      assert.equal((await request(answerPath, "POST", answer)).status, 403, "unattributed non-browser answer rejected");
      assert.equal((await request(answerPath, "POST", { ...answer, conversationId: "wrong" }, { origin: running.origin })).status, 409);
      assert.equal((await request(answerPath, "POST", answer, { origin: running.origin })).status, 200);
      await turn;
      assert.match(results.at(-1)!, /"status":"filled"/);
      assert.equal((await request(answerPath, "POST", answer, { origin: running.origin })).status, 200, "safe receipt retry");
      const transcript = JSON.stringify(running.host.controller.getConversation(conversationId));
      assert.ok(!transcript.includes(login.password) && !transcript.includes(login.username));
      const after = await (await request("/vault")).json();
      assert.equal(after.revision, before.revision + (kind === "save" ? 1 : 0));
      assert.equal(after.items.length, before.items.length + (kind === "save" ? 1 : 0));
    }
    const until = Date.now() + 3000;
    while (seen.length < 18 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(seen, Array.from({ length: 9 }, () => [login.username, login.password]).flat());
    assert.equal(submits, 0);
    assert.equal((await request("/vault", "POST", { item: { ...login, origin: siteOrigin }, revision: 0 })).status, 409);
    await running.close(); running = await start();
    const restored = await (await request("/vault")).json();
    assert.equal(restored.items.length, 4, "new saved logins survive host restart");
    assert.equal((await request("/vault", "DELETE", { id: view.items[0].id, revision: restored.revision })).status, 200);
    const privateFiles = readdirSync(vaultDir).filter(name => name.endsWith(".enc"));
    for (const file of privateFiles) assert.ok(!readFileSync(join(vaultDir, file), "utf8").includes(login.password));
  } finally {
    await running.close(); await browser.stop(); site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
