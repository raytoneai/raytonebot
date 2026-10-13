import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyBrowserCall } from "./browserPolicy.ts";
import { createBrowserService, findHeadlessShell } from "./browserService.ts";
import { startEgressProxy } from "./egressProxy.ts";
import { saveWorkspaceDownload } from "../workspaceFiles.ts";
import { resolveWorkspaceLayout } from "../workspaceLayout.ts";

const context = (elements: Record<string, object>, extra: object = {}) => ({ elements: elements as never, loggedIn: new Set<string>(), origin: "https://shop.example", ...extra });

test("browser actions are judged from the host's snapshot, never the model's label", () => {
  const elements = {
    e1: { role: "link", name: "Docs" },
    e2: { role: "button", name: "Send message" },
    e3: { role: "button", name: "Accept all cookies" },
    e4: { role: "button", name: "Search", submits: true, formMethod: "get" },
    e5: { role: "button", name: "Continue", submits: true, formMethod: "post" },
    e6: { role: "textbox", name: "Password", inputType: "password" },
    e7: { role: "textbox", name: "Code", autocomplete: "one-time-code" },
    e8: { role: "searchbox", name: "Search", inputType: "search", formMethod: "get" },
    e9: { role: "textbox", name: "Comment", formMethod: "post" },
    e10: { role: "button", name: "立即支付" },
  };
  const kind = (name: string, args: object, extra?: object) => classifyBrowserCall(name, args, context(elements, extra))?.kind;
  for (const name of ["browser_open", "browser_snapshot", "browser_scroll", "browser_back", "browser_request_takeover"]) assert.equal(kind(name, {}), "read", name);
  assert.equal(kind("browser_click", { ref: "e1", element: "Delete account" }), "mutating", "the model's description does not count");
  assert.equal(kind("browser_click", { ref: "e2" }), "outward");
  assert.equal(kind("browser_click", { ref: "e3" }), "outward", "cookie banners ask");
  assert.equal(kind("browser_click", { ref: "e4" }), "mutating", "a GET search form");
  assert.equal(kind("browser_click", { ref: "e5" }), "outward", "a POST form");
  assert.equal(kind("browser_click", { ref: "e10" }), "outward");
  assert.equal(kind("browser_click", { ref: "e99" }), "outward", "an element the snapshot does not know");
  assert.equal(kind("browser_type", { ref: "e6", text: "x" }), "secret");
  assert.equal(kind("browser_type", { ref: "e7", text: "x" }), "secret");
  assert.equal(kind("browser_type", { ref: "e8", text: "x", submit: true }), "mutating");
  assert.equal(kind("browser_type", { ref: "e9", text: "x" }), "mutating");
  assert.equal(kind("browser_type", { ref: "e9", text: "x", submit: true }), "outward");
  // Enter and Space act on whatever has focus, judged like a click on it.
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e2 }), "outward", "Tab to Send, then Enter");
  assert.equal(kind("browser_press", { key: "Space" }, { focused: elements.e10 }), "outward");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e5 }), "outward", "a POST form's button");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e9 }), "outward", "Enter in a POST form's field");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e8 }), "mutating", "a GET search field");
  assert.equal(kind("browser_press", { key: "Space" }, { focused: elements.e9 }), "mutating", "a space typed into a field");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e1 }), "mutating", "a plain link");
  assert.equal(kind("browser_press", { key: "Enter" }), "outward", "nothing known to be focused");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: { role: "generic", name: "" } }), "outward", "the page itself");
  assert.equal(kind("browser_press", { key: "Tab" }), "mutating");
  assert.equal(classifyBrowserCall("bash", {}, context(elements)), undefined);
  // Signed in by the user: ordinary writes ask and are remembered per site; outward stays outward.
  const signedIn = { loggedIn: new Set(["https://shop.example"]) };
  assert.deepEqual(classifyBrowserCall("browser_click", { ref: "e1" }, context(elements, signedIn)), { kind: "connector", key: "browser_click@https://shop.example" });
  assert.equal(kind("browser_click", { ref: "e2" }, signedIn), "outward");
});

test("the egress proxy refuses private addresses, other ports and names that resolve privately", async () => {
  const denied: unknown[] = [];
  const proxy = await startEgressProxy({ log: (_event, fields) => denied.push(fields) });
  const connectTo = (target: string) => new Promise<string>((resolve) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (data) => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); });
  });
  const get = (url: string) => new Promise<{ status: number; body: string }>((resolve) => {
    request({ host: "127.0.0.1", port: proxy.port, path: url, headers: { host: new URL(url).host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).end();
  });
  try {
    assert.match(await connectTo("127.0.0.1:443"), /403/);
    assert.match(await connectTo("169.254.169.254:443"), /403/);
    assert.match(await connectTo("10.0.0.1:443"), /403/);
    assert.match(await connectTo("localhost:443"), /403/, "a name resolving to loopback");
    assert.match(await connectTo("example.com:22"), /403/, "only 80 and 443");
    const page = await get("http://169.254.169.254/latest/meta-data/");
    assert.equal(page.status, 403);
    assert.match(page.body, /public websites/);
    assert.equal((await get("http://example.com:8080/")).status, 403);
    assert.ok(denied.length >= 7);
  } finally { await proxy.close(); }
});

test("a download never follows a link out of the workspace, and only a folder the bot made gets its mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-download-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "ws") });
  const workspace = layout.agents.assistant;
  const secret = join(root, "private");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(secret, { mode: 0o700 });
  chmodSync(secret, 0o700);
  try {
    // Paths come back as the workspace's real path (macOS temp dirs live under /private).
    const real = realpathSync(workspace);
    const first = await saveWorkspaceDownload(layout, "assistant", "a.txt", Buffer.from("one"));
    assert.equal(first, join(real, "downloads", "a.txt"));
    assert.equal(statSync(join(workspace, "downloads")).mode & 0o7777, 0o2770);
    assert.equal(statSync(first).mode & 0o777, 0o660);
    assert.equal(await saveWorkspaceDownload(layout, "assistant", "a.txt", Buffer.from("two")), join(real, "downloads", "a (2).txt"), "never overwritten");
    // An agent swaps the folder for a link to a private directory: refused, nothing written or changed there.
    renameSync(join(workspace, "downloads"), join(workspace, "old-downloads"));
    symlinkSync(secret, join(workspace, "downloads"));
    await assert.rejects(saveWorkspaceDownload(layout, "assistant", "b.txt", Buffer.from("x")), /link/);
    assert.deepEqual(readdirSync(secret), []);
    assert.equal(statSync(secret).mode & 0o7777, 0o700);
    // A link in place of the file itself is refused too.
    rmSync(join(workspace, "downloads"));
    mkdirSync(join(workspace, "downloads"));
    symlinkSync(join(secret, "planted"), join(workspace, "downloads", "c.txt"));
    assert.equal(await saveWorkspaceDownload(layout, "assistant", "c.txt", Buffer.from("x")), join(real, "downloads", "c (2).txt"));
    assert.equal(existsSync(join(secret, "planted")), false);
    await assert.rejects(saveWorkspaceDownload(layout, "assistant", "../x", Buffer.from("x")), /Invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const shell = findHeadlessShell();

test("a real browser: snapshot refs, secret fields refused, takeover, per-site sign-in and downloads", { skip: !shell && "no Chromium headless shell installed" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: dataDir, root: join(dataDir, "ws") });
  const workspace = layout.agents.assistant;
  mkdirSync(workspace, { recursive: true });
  const site: Server = createServer((req, res) => {
    if (req.url === "/report.txt") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" }); res.end("quarterly numbers\n"); return; }
    if (req.url === "/tool.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=tool.bin" }); res.end(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Shop</title><input aria-label="Pinned" style="position:absolute;left:0;top:0;width:300px;height:40px"><button type="button" style="position:absolute;left:320px;top:0" onclick="setTimeout(() => document.querySelector('[aria-label=Pinned]').focus(), 800)">Later</button><div style="height:60px"></div><form method="post" action="/order"><label>Note <input name="note"></label><label>Password <input type="password" name="pw"></label><button>Place order</button></form>
      <a href="/report.txt">Report</a> <a href="/tool.bin">Tool</a>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const service = createBrowserService({ dataDir, allowAddress: (address) => address === "127.0.0.1", allowPort: (value) => value === port });
  const questions: string[] = [];
  const tools = service.toolsFor({ conversationId: "c", agent: "assistant", saveDownload: (name, bytes) => saveWorkspaceDownload(layout, "assistant", name, bytes), ask: async (asked) => { questions.push(asked[0].question); return { browser_takeover: ["已完成"] }; } })!;
  const ref = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
  try {
    const opened = await tools.run("browser_open", { url: `http://127.0.0.1:${port}/` });
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, /Title: Shop/);
    const password = ref(opened.text, /textbox "Password" \[ref=([a-z0-9]+)\]/)!;
    const note = ref(opened.text, /textbox "Note" \[ref=([a-z0-9]+)\]/)!;
    const order = ref(opened.text, /button "Place order" \[ref=([a-z0-9]+)\]/)!;
    assert.equal(service.classify("browser_type", { ref: password, text: "x" })?.kind, "secret");
    assert.equal(service.classify("browser_click", { ref: order })?.kind, "outward");
    assert.equal(service.classify("browser_type", { ref: note, text: "x" })?.kind, "mutating");
    // Even if a gate were bypassed, the worker refuses to type into the password field.
    const typed = await tools.run("browser_type", { ref: password, text: "hunter2" });
    assert.equal(typed.isError, true);
    assert.match(typed.text, /never type/);

    // The reported bypass: type into a field, Tab to a sending button, Enter. Judged on the focused button.
    await tools.run("browser_type", { ref: note, text: "hello" });
    const tabbed = await tools.run("browser_press", { key: "Tab" });
    assert.match(tabbed.text, /textbox "Password" \[active\]/, "Tab moved focus to the password field");
    await tools.run("browser_press", { key: "Tab" });
    assert.equal(service.classify("browser_press", { key: "Enter" })?.kind, "outward", "Enter on the focused Place order button");
    // Approved against the focused element in the snapshot; the page moves focus afterwards: refused.
    const later = ref((await tools.run("browser_snapshot", {})).text, /button "Later" \[ref=([a-z0-9]+)\]/)!;
    const clicked = await tools.run("browser_click", { ref: later });
    assert.match(clicked.text, /button "Later" \[active\]/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const pressed = await tools.run("browser_press", { key: "Enter" });
    assert.equal(pressed.isError, true);
    assert.match(pressed.text, /Focus moved/);

    // Downloads: a text file lands in the workspace, a program does not.
    const seen = [(await tools.run("browser_click", { ref: ref(opened.text, /link "Report" \[ref=([a-z0-9]+)\]/) })).text,
      (await tools.run("browser_click", { ref: ref(opened.text, /link "Tool" \[ref=([a-z0-9]+)\]/) })).text];
    for (let i = 0; i < 50 && !existsSync(join(workspace, "downloads", "report.txt")); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readFileSync(join(workspace, "downloads", "report.txt"), "utf8"), "quarterly numbers\n");
    assert.equal(statSync(join(workspace, "downloads", "report.txt")).mode & 0o777, 0o660, "shared with the agents' group, never executable");
    assert.equal(statSync(join(workspace, "downloads")).mode & 0o7777, 0o2770);
    assert.deepEqual(readdirSync(join(workspace, "downloads")), ["report.txt"]);
    // Each note comes once, with whichever result follows the download.
    seen.push((await tools.run("browser_snapshot", {})).text);
    assert.match(seen.join("\n"), /Downloaded report\.txt/);
    assert.match(seen.join("\n"), /tool\.bin looks like a program/);

    // Takeover: agent actions wait for the user; afterwards the site counts as signed in.
    await service.takeover();
    assert.equal(service.view().controller, "user");
    assert.match((await tools.run("browser_snapshot", {})).text, /user is controlling/);
    // The user's own clicks and text from the live view reach the page.
    await service.input({ kind: "mouse", type: "down", x: 50, y: 20, button: "left" });
    await service.input({ kind: "mouse", type: "up", x: 50, y: 20, button: "left" });
    await service.input({ kind: "text", text: "用户输入" });
    await service.input({ kind: "key", type: "down", key: "Backspace" });
    await service.input({ kind: "key", type: "up", key: "Backspace" });
    service.release();
    assert.equal(service.view().controller, "agent");
    const again = await tools.run("browser_snapshot", {});
    assert.match(again.text, /textbox "Pinned"[^\n]*: 用户输/, again.text.slice(0, 400));
    const noteAgain = ref(again.text, /textbox "Note" \[ref=([a-z0-9]+)\]/)!;
    assert.deepEqual(service.classify("browser_type", { ref: noteAgain, text: "x" }), { kind: "connector", key: `browser_type@http://127.0.0.1:${port}` });
    assert.match(readFileSync(join(dataDir, "browser.json"), "utf8"), new RegExp(`127.0.0.1:${port}`));

    const takeover = await tools.run("browser_request_takeover", { reason: "请登录" });
    assert.deepEqual(questions, ["请登录"]);
    assert.match(takeover.text, /handed the browser back/);
    // Stopping ends Chrome itself, not just the worker: nothing keeps running on this profile.
    await service.stop();
    assert.equal(service.view().running, false);
    const left = (() => { try { return execFileSync("pgrep", ["-f", join(dataDir, "browser", "profile")], { encoding: "utf8" }).trim(); } catch { return ""; } })();
    assert.equal(left, "", "a browser process outlived stop()");
  } finally {
    await service.stop();
    site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
