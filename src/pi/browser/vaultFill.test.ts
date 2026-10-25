import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserService, findHeadlessShell } from "./browserService.ts";

const username = "dummy-vault-user@example.invalid";
const password = "dummy-vault-password-#24";
const credentials = { username, password };
const refs = (text: string) => ({
  snapshotId: /^Snapshot: (.+)$/m.exec(text)![1],
  usernameRef: /textbox "Username" \[ref=([a-z0-9]+)\]/.exec(text)![1],
  passwordRef: /textbox "Password" \[ref=([a-z0-9]+)\]/.exec(text)![1],
});

test("Login Vault binds exact live fields, never submits, and hides model output", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-vault-browser-"));
  let submits = 0;
  let savedDownloads = 0;
  let attemptedDownloads = 0;
  let mutationResponse: ServerResponse | undefined;
  let markMutated!: () => void;
  const mutated = new Promise<void>(resolve => { markMutated = resolve; });
  const received: { field: string; value: string }[] = [];
  const site = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/mutation-ready") { mutationResponse = res; return; }
    if (url.pathname === "/mutation-done") { markMutated(); res.end("ok"); return; }
    if (url.pathname === "/submit") submits++;
    if (url.pathname === "/download") { attemptedDownloads++; res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="credentials.txt"' }); res.end(username + password); return; }
    if (url.pathname === "/seen") {
      received.push({ field: url.searchParams.get("field")!, value: url.searchParams.get("value")! });
      res.end("ok"); return;
    }
    if (url.pathname === "/slow") { setTimeout(() => res.end("Navigation complete"), 500); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<title>Dummy login</title><form action="/submit" method="post"><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="${url.pathname === "/new" ? "new-password" : "current-password"}"></label><button>Sign in</button></form><p id="echo"></p><script>
      for (const id of ['username','password']) document.getElementById(id).addEventListener('input', e => {
        fetch('/seen?field='+id+'&value='+encodeURIComponent(e.target.value));
        document.title=e.target.value; document.getElementById('echo').textContent=e.target.value;
        if (id === 'password' && ${JSON.stringify(url.pathname)} === '/download-page') { const a=document.createElement('a'); a.href='/download'; a.download='credentials.txt'; document.body.append(a); a.click(); }
        if (id === 'password' && ${JSON.stringify(url.pathname)} === '/url') { history.replaceState({}, '', '/echo?value='+encodeURIComponent(e.target.value)); alert(e.target.value); }
        if (${JSON.stringify(url.pathname)} === '/replace' && id === 'username') document.getElementById('password').outerHTML='<input id="password" type="password" autocomplete="current-password" aria-label="Password">';
        if (${JSON.stringify(url.pathname)} === '/navigate' && id === 'username') location.href='/slow';
      });
      ${url.pathname === "/replace-before-fill" ? `fetch('/mutation-ready').then(() => { const node=document.getElementById('password');node.replaceWith(node.cloneNode());fetch('/mutation-done'); });` : ""}
      ${url.pathname === "/reveal" ? `document.title=${JSON.stringify(password)};document.getElementById('echo').textContent=${JSON.stringify(username + " " + password)};alert(${JSON.stringify(password)});` : ""}
    </script>`);
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const service = createBrowserService({ dataDir, testOnlyAllowHttpLoopbackVault: true, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
  const tools = (conversationId: string) => service.toolsFor({ conversationId, agent: "assistant", saveDownload: async () => { savedDownloads++; return "/forbidden"; }, ask: async () => null })!;
  const a = tools("a"), b = tools("b");
  const open = async (path = "/") => {
    const result = await a.run("browser_open", { url: `http://127.0.0.1:${port}${path}` });
    assert.equal(result.isError, false, result.text);
    return refs(result.text);
  };
  const clean = (text: string) => { assert.ok(!text.includes(username), text); assert.ok(!text.includes(password), text); };
  try {
    let input = await open();
    assert.equal((await a.run("browser_type", { ref: input.passwordRef, text: "ordinary tool blocked" })).isError, true);
    await assert.rejects(service.captureLoginTarget("b", input), /expired/);
    const old = await service.captureLoginTarget("a", input);
    await b.run("browser_snapshot", {});
    await assert.rejects(service.fillLogin(old, credentials), /expired/);
    input = await open();
    const stale = await service.captureLoginTarget("a", input);
    await a.run("browser_snapshot", {});
    await assert.rejects(service.fillLogin(stale, credentials), /expired/);
    input = await open();
    const moved = await service.captureLoginTarget("a", input);
    await open("/other");
    await assert.rejects(service.validateLoginTarget(moved), /expired/);
    await assert.rejects(service.fillLogin(moved, credentials), /expired/);
    input = await open();
    const taken = await service.captureLoginTarget("a", input);
    await service.takeover(); await service.release();
    await assert.rejects(service.validateLoginTarget(taken), /expired/);
    await assert.rejects(service.fillLogin(taken, credentials), /expired/);
    input = await open();
    const cancelled = await service.captureLoginTarget("a", input);
    await assert.rejects(service.fillLogin(cancelled, credentials, AbortSignal.abort(password)), error => { clean(String(error)); return true; });
    input = await open("/replace-before-fill");
    const detached = await service.captureLoginTarget("a", input);
    await service.validateLoginTarget(detached);
    while (!mutationResponse) await new Promise(resolve => setTimeout(resolve, 5));
    mutationResponse.end("replace"); await mutated;
    await assert.rejects(service.validateLoginTarget(detached), "pre-save check keeps original node identity instead of recapturing replacement refs");
    assert.deepEqual(received, [], "pre-save validation enters no credentials");
    input = await open();
    const revoked = await service.captureLoginTarget("a", input);
    let validations = 0;
    await assert.rejects(service.fillLogin(revoked, credentials, undefined, () => { if (++validations === 2) throw new Error("item revoked"); }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, [{ field: "username", value: username }], "revocation between inputs prevents password fill");
    received.length = 0;
    input = await open("/navigate");
    const navigating = await service.captureLoginTarget("a", input);
    await assert.rejects(service.fillLogin(navigating, credentials), error => { clean(String(error)); return true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, [{ field: "username", value: username }], "navigation between fields never receives the password");
    received.length = 0;
    input = await open("/new");
    await assert.rejects(service.captureLoginTarget("a", input));
    input = await open("/replace");
    const replacement = await service.captureLoginTarget("a", input);
    await assert.rejects(service.fillLogin(replacement, credentials), error => { clean(String(error)); return true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, [{ field: "username", value: username }], "replacement password never receives the secret");
    received.length = 0;
    input = await open();
    const target = await service.captureLoginTarget("a", input);
    await service.validateLoginTarget(target);
    await service.fillLogin(target, credentials);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, [{ field: "username", value: username }, { field: "password", value: password }]);
    assert.equal(submits, 0);
    for (const mode of ["full", "content", "interactive"]) {
      const text = (await a.run("browser_snapshot", { mode })).text; clean(text); assert.match(text, /Page content is hidden/);
      const screenshot = await a.run("browser_screenshot", { snapshotId: /^Snapshot: (.+)$/m.exec(text)![1] });
      assert.equal(screenshot.isError, true);
      assert.equal(screenshot.images, undefined);
      assert.match(screenshot.text, /hidden after Login Vault fill/);
    }
    input = await open("/url");
    const urlTarget = await service.captureLoginTarget("a", input);
    await service.fillLogin(urlTarget, credentials).catch(error => clean(String(error)));
    const hidden = (await a.run("browser_snapshot", {})).text;
    assert.match(hidden, /Page content is hidden/);
    assert.ok(!hidden.includes(encodeURIComponent(password)));
    clean((await a.run("browser_tabs", {})).text);
    const reveal = await a.run("browser_open", { url: `http://127.0.0.1:${port}/reveal` }); clean(reveal.text);
    assert.match(reveal.text, /redacted/);
    clean((await a.run("browser_snapshot", { mode: "content" })).text);
    clean((await a.run("browser_snapshot", { scope: `[${password}` })).text);
    input = await open("/download-page");
    const downloadTarget = await service.captureLoginTarget("a", input);
    await service.fillLogin(downloadTarget, credentials).catch(error => clean(String(error)));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(attemptedDownloads > 0, "the real page attempted a credential download");
    assert.equal(savedDownloads, 0, "a credential-bearing page cannot save downloaded secrets into the agent workspace");
    const prefs = JSON.parse(readFileSync(join(dataDir, "browser/profile/Default/Preferences"), "utf8"));
    assert.equal(prefs.credentials_enable_service, false);
    assert.equal(prefs.profile.password_manager_enabled, false);
    assert.equal(prefs.autofill.credit_card_enabled, false);
    assert.equal(submits, 0);
  } finally {
    await service.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Login Vault refuses HTTP without its explicit loopback test hook", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 15_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-vault-https-"));
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>'); });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const service = createBrowserService({ dataDir, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
  try {
    const a = service.toolsFor({ conversationId: "a", agent: "assistant", saveDownload: async () => "", ask: async () => null })!;
    const result = await a.run("browser_open", { url: `http://127.0.0.1:${port}` });
    assert.equal(result.isError, false, result.text);
    await assert.rejects(service.captureLoginTarget("a", refs(result.text)), /HTTPS/);
  } finally {
    await service.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const shortUsername of ["a", "e"]) test(`Vault username ${shortUsername} keeps browser handles usable and page echoes hidden`, { skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-vault-short-name-"));
  const site = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/login") res.end('<label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>');
    else if (req.url?.startsWith("/echo")) res.end(`<title>${password}</title><p>${shortUsername}</p><input aria-label="${password}" placeholder="${password}" value="${password}"><button aria-label="${password}: it's &quot;quoted&quot; [ref=e9]">Go</button><a href="/${password}">${password}</a><p>${"visible line ".repeat(1500)}</p>`);
    else res.end('<input aria-label="Note"><button>Pay</button><button onclick="this.textContent=\'OK\'">Go</button>');
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const service = createBrowserService({ dataDir, testOnlyAllowHttpLoopbackVault: true, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
  const tools = service.toolsFor({ conversationId: "short-name", agent: "assistant", saveDownload: async () => "", ask: async () => null })!;
  const open = async (path: string) => {
    const result = await tools.run("browser_open", { url: `http://127.0.0.1:${port}${path}` });
    assert.equal(result.isError, false, result.text);
    return result.text;
  };
  const snapshotId = (text: string) => {
    assert.match(text, /^Snapshot: [a-f0-9-]{36}$/m);
    return /^Snapshot: (.+)$/m.exec(text)![1];
  };
  try {
    const login = await open("/login");
    await service.fillLogin(await service.captureLoginTarget("short-name", refs(login)), { username: shortUsername, password });
    for (const restart of [false, true]) {
      if (restart) await service.stop();
      const controls = await open("/controls");
      const accountState = JSON.parse((await tools.run("browser_accounts", {})).text.split("\n")[1]);
      assert.deepEqual(accountState, { controller: "agent", clearing: false, accounts: [] });
      assert.match(service.contextNote(), /"controller":"agent","clearing":false/);
      assert.match(service.contextNote(), /browser_accounts for full list/);
      const shot = await tools.run("browser_screenshot", { snapshotId: snapshotId(controls) });
      assert.equal(shot.isError, false, shot.text);
      assert.equal(shot.images?.[0].mimeType, "image/jpeg");
      const field = /- textbox[^\n]*\[ref=([a-z0-9]+)\]/.exec(controls)?.[1];
      assert.ok(field, controls);
      const pay = /- button[^\n]*\[ref=([a-z0-9]+)\]/.exec(controls)![1];
      assert.equal(service.classify("browser_click", { ref: pay })?.kind, "outward", "redacted labels must not weaken approval classification");
      const typed = await tools.run("browser_type", { ref: field, text: "xyz" });
      assert.equal(typed.isError, false, typed.text);
      const pressed = await tools.run("browser_press", { key: "Backspace", snapshotId: snapshotId(typed.text) });
      assert.equal(pressed.isError, false, pressed.text);
      assert.match(pressed.text, /: xy\b/);
      const go = /button "Go" \[ref=([a-z0-9]+)\]/.exec(pressed.text)![1];
      assert.equal((await tools.run("browser_click", { ref: go })).isError, false);
      const tabs = JSON.parse((await tools.run("browser_tabs", {})).text);
      assert.equal(tabs.pageId, service.view().pageId);
      assert.equal(tabs.tabs[0].id, tabs.pageId);
      assert.equal((await tools.run("browser_tabs", { pageId: tabs.tabs[0].id })).isError, false);
      const echo = await open(`/echo?value=${password}`);
      assert.ok(!echo.includes(password), echo);
      assert.match(echo, /^Title: \[redacted\]$/m);
      assert.match(echo, /textbox "\[redacted\]" \[ref=[a-z0-9]+\]/);
      const offset = /browser_snapshot with offset=(\d+)/.exec(echo)?.[1];
      assert.ok(offset, "pagination instructions must stay intact");
      const more = await tools.run("browser_snapshot", { offset: Number(offset) });
      assert.equal(more.isError, false, more.text);
      assert.equal(snapshotId(more.text), snapshotId(echo));
      for (const mode of ["content", "interactive"]) {
        const result = await tools.run("browser_snapshot", { mode });
        assert.equal(result.isError, false, result.text);
        assert.ok(!result.text.includes(password), result.text);
      }
      assert.ok(!(await tools.run("browser_tabs", {})).text.includes(password));
      const error = await tools.run("browser_snapshot", { scope: `[${password}` });
      assert.equal(error.isError, true);
      assert.ok(!error.text.includes(password), error.text);
    }
  } finally {
    await service.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true });
  }
});
