import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserService, findHeadlessShell } from "./browserService.ts";

test("model screenshots return image bytes, bind the conversation, and respect takeover and cancellation", { skip: !findHeadlessShell() && "Chromium not installed" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-vision-"));
  const site = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/filled-frame") res.end('<iframe src="/filled"></iframe>');
    else res.end(`<title>Visual fixture</title><h1>Screenshot fixture</h1><input type="password" autocomplete="current-password" value="${req.url === "/filled" ? "dummy-secret" : ""}">`);
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const browser = createBrowserService({ dataDir, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
  const tools = (conversationId: string) => browser.toolsFor({ conversationId, agent: "assistant", ask: async () => null, saveDownload: async () => "unused" })!;
  const a = tools("a"), b = tools("b");
  try {
    const opened = await a.run("browser_open", { url: `http://127.0.0.1:${port}` });
    const snapshotId = /^Snapshot: (.+)$/m.exec(opened.text)![1];
    const result = await a.run("browser_screenshot", { snapshotId });
    assert.equal(result.isError, false, result.text);
    const image = (result as typeof result & { images?: { data: string; mimeType: string }[] }).images?.[0];
    assert.equal(image?.mimeType, "image/jpeg");
    assert.equal(Buffer.from(image!.data, "base64").subarray(0, 3).toString("hex"), "ffd8ff");
    assert.equal(browser.classify("browser_screenshot", {})?.kind, "read");
    assert.equal((await b.run("browser_screenshot", { snapshotId })).isError, true);
    const stop = new AbortController(); stop.abort();
    assert.equal((await a.run("browser_screenshot", { snapshotId }, stop.signal)).isError, true);
    await browser.takeover();
    assert.equal((await a.run("browser_screenshot", { snapshotId })).isError, true);
    await browser.release();
    assert.equal((await a.run("browser_screenshot", { snapshotId })).isError, true);
    for (const path of ["/filled", "/filled-frame"]) {
      const page = await a.run("browser_open", { url: `http://127.0.0.1:${port}${path}` });
      const refused = await a.run("browser_screenshot", { snapshotId: /^Snapshot: (.+)$/m.exec(page.text)![1] });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /secret fields/);
      assert.equal(refused.images, undefined);
    }
  } finally {
    await browser.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cross-origin iframe refs act inside their frame and keep submission approval", { skip: !findHeadlessShell() && "Chromium not installed" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-frames-"));
  const child = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/nested") res.end('<input aria-label="Nested note">');
    else res.end('<title>Frame</title><form method="post"><label>Frame note<input name="note"></label><button>Save note</button></form><input type="password" aria-label="Secret" autocomplete="current-password"><iframe title="Nested" src="/nested"></iframe><script>Object.defineProperty(window,"origin",{value:"https://public.invalid"})</script>');
  });
  await new Promise<void>(resolve => child.listen(0, "127.0.0.1", resolve));
  const childPort = (child.address() as { port: number }).port;
  const parent = createServer((_req, res) => res.end(`<title>Parent</title><label>Frame note<input value="parent untouched"></label><iframe title="Editor" src="http://127.0.0.1:${childPort}/"></iframe>`));
  await new Promise<void>(resolve => parent.listen(0, "127.0.0.1", resolve));
  const parentPort = (parent.address() as { port: number }).port;
  writeFileSync(join(dataDir, "browser.json"), JSON.stringify({ loggedIn: [`http://127.0.0.1:${childPort}`] }));
  const browser = createBrowserService({ dataDir, allowAddress: ip => ip === "127.0.0.1", allowPort: p => [parentPort, childPort].includes(p) });
  const tools = browser.toolsFor({ conversationId: "a", agent: "assistant", ask: async () => null, saveDownload: async () => "unused" })!;
  const ref = (text: string, role: string, name: string) => [...text.matchAll(new RegExp(`${role} "${name}" \\[ref=([a-z0-9]+)\\]`, "g"))].at(-1)![1];
  try {
    await tools.run("browser_open", { url: `http://127.0.0.1:${parentPort}` });
    const shot = await tools.run("browser_snapshot", {});
    const field = ref(shot.text, "textbox", "Frame note");
    assert.deepEqual(browser.classify("browser_type", { ref: field }), { kind: "connector", key: `browser_type@http://127.0.0.1:${childPort}` });
    assert.equal(browser.classify("browser_type", { ref: field, submit: true })?.kind, "outward");
    const typed = await tools.run("browser_type", { ref: field, text: "跨域保存" });
    assert.equal(typed.isError, false, typed.text);
    assert.match(typed.text, /跨域保存/);
    assert.match(typed.text, /parent untouched/);
    assert.equal(browser.classify("browser_click", { ref: ref(typed.text, "button", "Save note") })?.kind, "outward");
    assert.equal((await tools.run("browser_type", { ref: ref(typed.text, "textbox", "Secret"), text: "must not reach field" })).isError, true);
    const iframeRef = /iframe[^\n]*\[ref=([a-z0-9]+)\]/.exec(typed.text)![1];
    const scoped = await tools.run("browser_snapshot", { frameRef: iframeRef, scope: "form" });
    assert.equal(scoped.isError, false, scoped.text);
    assert.match(scoped.text, /跨域保存/);
    assert.doesNotMatch(scoped.text, /parent untouched/);
    assert.equal((await tools.run("browser_snapshot", { frameRef: iframeRef })).isError, true, "frame refs expire on the next snapshot too");
    const full = await tools.run("browser_snapshot", {});
    const outer = /iframe[^\n]*\[ref=([a-z0-9]+)\]/.exec(full.text)![1];
    const frame = await tools.run("browser_snapshot", { frameRef: outer });
    assert.equal(frame.isError, false, frame.text);
    const nestedRef = /iframe[^\n]*\[ref=([a-z0-9]+)\]/.exec(frame.text)![1];
    const nested = await tools.run("browser_snapshot", { frameRef: nestedRef });
    assert.equal(nested.isError, false, nested.text);
    const nestedTyped = await tools.run("browser_type", { ref: ref(nested.text, "textbox", "Nested note"), text: "nested text" });
    assert.equal(nestedTyped.isError, false, nestedTyped.text);
    const pressed = await tools.run("browser_press", { snapshotId: /^Snapshot: (.+)$/m.exec(nestedTyped.text)![1], key: "Backspace" });
    assert.equal(pressed.isError, false, pressed.text);
    assert.match(pressed.text, /nested tex/);
  } finally {
    await browser.stop();
    for (const site of [parent, child]) { site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("frame navigation expires child refs even when the replacement has identical controls", { skip: !findHeadlessShell() && "Chromium not installed" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-frame-navigation-"));
  let navigated!: () => void;
  const changed = new Promise<void>(resolve => { navigated = resolve; });
  const site = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/changed") { navigated(); res.end("ok"); }
    else if (req.url?.startsWith("/child")) res.end('<input aria-label="Child note"><button>Continue</button>');
    else res.end('<input aria-label="Parent note"><button onclick="setTimeout(()=>{const f=document.querySelector(\'iframe\'); f.onload=()=>fetch(\'/changed\'); f.src=\'/child?new\'},800)">Refresh frame</button><iframe src="/child"></iframe>');
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const browser = createBrowserService({ dataDir, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
  const tools = browser.toolsFor({ conversationId: "a", agent: "assistant", ask: async () => null, saveDownload: async () => "unused" })!;
  const ref = (text: string, name: string) => new RegExp(`"${name}" \\[ref=([a-z0-9]+)\\]`).exec(text)![1];
  try {
    const opened = await tools.run("browser_open", { url: `http://127.0.0.1:${port}` });
    const armed = await tools.run("browser_click", { ref: ref(opened.text, "Refresh frame") });
    assert.equal(armed.isError, false, armed.text);
    await changed;
    assert.equal((await tools.run("browser_screenshot", { snapshotId: /^Snapshot: (.+)$/m.exec(armed.text)![1] })).isError, true, "visual capture must match every frame in the snapshot");
    const frameRef = /iframe[^\n]*\[ref=([a-z0-9]+)\]/.exec(armed.text)![1];
    assert.equal((await tools.run("browser_snapshot", { frameRef })).isError, true, "frame selection cannot reuse approval across navigation");
    const stale = await tools.run("browser_type", { ref: ref(armed.text, "Child note"), text: "must not reach new frame" });
    assert.equal(stale.isError, true, stale.text);
    const fresh = await tools.run("browser_snapshot", {});
    assert.doesNotMatch(fresh.text, /must not reach new frame/);
  } finally {
    await browser.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
