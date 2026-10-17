import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BrowserPageSummary, BrowserRequest, BrowserWorkerMessage } from "./browserProtocol.ts";
import { findHeadlessShell } from "./browserService.ts";
import { startEgressProxy } from "./egressProxy.ts";

const executable = findHeadlessShell();

test("browser worker lifecycle through real Chromium and IPC", { skip: !executable && "no Chromium headless shell installed", timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rtb-worker-lifecycle-"));
  const changed = new Map<string, () => void>();
  let posts = 0;
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://test");
    if (req.method === "POST") { posts += 1; res.end("posted"); return; }
    if (url.pathname === "/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    if (url.pathname === "/changed") { changed.get(url.searchParams.get("kind")!)?.(); res.end("ok"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    if (url.pathname === "/popup") {
      res.end('<title>Popup</title><input autofocus aria-label="Popup field"><button onclick="window.close()">Close popup</button>');
    } else if (url.pathname === "/slow") {
      res.end('<title>Slow SPA</title><p id="busy">Busy</p><p id="later"></p><script>new EventSource("/events"); setTimeout(() => { document.querySelector("#later").textContent="Content ready"; document.querySelector("#busy").hidden=true }, 1000)</script>');
    } else if (url.pathname === "/duplicates") {
      res.end('<title>Duplicates</title><p hidden>Duplicate status</p><p>Duplicate status</p><a href="/wait-close-popup" target="_blank">Wait popup</a>');
    } else if (url.pathname === "/wait-close-popup") {
      res.end('<title>Closing popup</title><p>Popup open</p><script>setTimeout(() => window.close(), 600)</script>');
    } else if (url.pathname === "/scope") {
      res.end('<title>Scope</title><section id="article"><h2>Article heading</h2><p>Scoped details</p><a href="/next">Continue reading</a><input aria-label="Code" autocomplete="one-time-code" value="secret-token"><input aria-label="Note"></section><aside>Outside private text</aside>');
    } else if (url.pathname === "/many") {
      res.end(`<title>Many controls</title>${Array.from({ length: 205 }, (_, index) => `<button>Item ${index}</button>`).join("")}<input aria-label="Late code" autocomplete="one-time-code" value="late-secret">`);
    } else if (url.pathname === "/facts") {
      const kind = url.searchParams.get("kind") === "name" ? "name" : "method";
      const mutation = kind === "name" ? 'go.textContent="Place order"' : 'go.setAttribute("formmethod", "post")';
      res.end(`<title>Facts</title><form method="get" action="/submit"><button id="go" formmethod="get">Continue</button><button id="arm" type="button">Arm change</button></form><script>document.querySelector('#arm').onclick=()=>setTimeout(() => { const go=document.querySelector('#go'); ${mutation}; fetch('/changed?kind=${kind}') }, 600)</script>`);
    } else {
      res.end('<title>Main</title><input aria-label="Main field"><a href="/popup" target="_blank">Open popup</a><p>Main content</p>');
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const proxy = await startEgressProxy({ allowAddress: (address) => address === "127.0.0.1", allowPort: (value) => value === port });
  const worker = fork(new URL("./browserWorker.ts", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
  let stderr = "";
  worker.stderr?.on("data", (chunk) => { stderr += chunk; });
  const events: BrowserWorkerMessage[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  worker.on("message", (raw) => {
    const message = raw as BrowserWorkerMessage;
    if (!("id" in message)) { events.push(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error));
  });
  worker.once("exit", (code) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`worker exited ${code}: ${stderr}`)); }
    pending.clear();
  });
  const request = <T = BrowserPageSummary>(operation: BrowserRequest): Promise<T> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`worker request timed out: ${operation.op}; ${stderr}`)); }, 20_000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    worker.send({ id, request: operation });
  });
  const ref = (shot: BrowserPageSummary, name: string) => {
    const entry = Object.entries(shot.elements).find(([, element]) => element.name === name);
    assert.ok(entry, `no ref for ${name}: ${shot.snapshot}`);
    return entry[0];
  };
  const click = (shot: BrowserPageSummary, name: string) => request({ op: "click", ref: ref(shot, name), snapshotId: shot.snapshotId });
  try {
    mkdirSync(join(directory, "downloads"));
    await request({ op: "launch", options: { executable: executable!, profileDir: join(directory, "profile"), downloadDir: join(directory, "downloads"), proxyPort: proxy.port } });

    await t.test("popups become active, receive input, switch tabs and close back to their opener", async () => {
      const main = await request({ op: "open", url: origin });
      await request({ op: "screencast", on: true });
      const popup = await click(main, "Open popup");
      assert.equal(popup.title, "Popup");
      assert.notEqual(popup.pageId, main.pageId);
      const listing = await request<{ pageId: string; tabs: { id: string; title: string }[] }>({ op: "tabs" });
      assert.equal(listing.pageId, popup.pageId);
      assert.deepEqual(listing.tabs.map((tab) => tab.title).sort(), ["Main", "Popup"]);
      await request({ op: "input", input: { kind: "text", text: "popup input" } });
      const edited = await request({ op: "snapshot" });
      assert.match(edited.snapshot, /popup input/);
      await assert.rejects(request({ op: "input", pageId: main.pageId, input: { kind: "text", text: "old tab input" } }), /tab changed.*discarded/);
      const unchanged = await request({ op: "snapshot" });
      assert.match(unchanged.snapshot, /popup input/);
      assert.doesNotMatch(unchanged.snapshot, /old tab input/);
      await assert.rejects(click(popup, "Close popup"), /changed since approval/);
      const switched = await request({ op: "tabs", pageId: main.pageId });
      assert.equal(switched.title, "Main");
      await assert.rejects(click(edited, "Close popup"), /changed since approval/);
      const restored = await request({ op: "tabs", pageId: popup.pageId });
      assert.match(restored.snapshot, /popup input/);
      const closed = await click(restored, "Close popup");
      assert.equal(closed.pageId, main.pageId);
      assert.equal(closed.title, "Main");
      const frames = events.filter((event): event is Extract<BrowserWorkerMessage, { event: "frame" }> => "event" in event && event.event === "frame");
      assert.ok(frames.length > 0, "live screencast produced frames");
      for (let index = 0; index < frames.length; index += 1) {
        assert.ok([main.pageId, popup.pageId].includes(frames[index].pageId));
        assert.ok(frames[index].capturedAt > 0);
        if (index) assert.ok(frames[index].seq > frames[index - 1].seq);
      }
      await request({ op: "screencast", on: false });
    });

    await t.test("snapshot IDs bind actions to the exact snapshot and user input invalidates them", async () => {
      const first = await request({ op: "open", url: origin });
      const second = await request({ op: "snapshot" });
      assert.notEqual(first.snapshotId, second.snapshotId);
      await assert.rejects(request({ op: "type", ref: ref(first, "Main field"), text: "stale", snapshotId: first.snapshotId }), /changed since approval/);
      await assert.rejects(request({ op: "type", ref: ref(second, "Main field"), text: "missing" }), /changed since approval/);
      await request({ op: "input", input: { kind: "key", type: "down", key: "Tab" } });
      await request({ op: "input", input: { kind: "key", type: "up", key: "Tab" } });
      await assert.rejects(request({ op: "press", key: "Enter", snapshotId: second.snapshotId, expectRef: ref(second, "Open popup") }), /changed since approval/);
      const fresh = await request({ op: "snapshot" });
      const typed = await request({ op: "type", ref: ref(fresh, "Main field"), text: "current", snapshotId: fresh.snapshotId });
      assert.match(typed.snapshot, /current/);
    });

    await t.test("live formmethod and accessible name changes refuse previously approved actions", async () => {
      for (const kind of ["method", "name"]) {
        const notification = new Promise<void>((resolve) => changed.set(kind, resolve));
        const opened = await request({ op: "open", url: `${origin}/facts?kind=${kind}` });
        const armed = await click(opened, "Arm change");
        assert.equal(armed.elements[ref(armed, "Continue")].formMethod, "get");
        await notification;
        await assert.rejects(click(armed, "Continue"), /changed since approval/);
      }
      assert.equal(posts, 0, "neither a changed submit nor a renamed button was executed");
    });

    await t.test("slow SPA text waits and explicit timeouts work with a persistent SSE connection", async () => {
      const opened = await request({ op: "open", url: `${origin}/slow` });
      assert.doesNotMatch(opened.snapshot, /Content ready/);
      assert.ok(opened.notes.some((note) => note.includes("browser_wait_for")));
      const ready = await request({ op: "wait", text: "Content ready", hidden: false, timeout: 5000 });
      assert.match(ready.snapshot, /Content ready/);
      await request({ op: "wait", text: "Busy", hidden: true, timeout: 1000 });
      await assert.rejects(request({ op: "wait", text: "Never appears", hidden: false, timeout: 100 }), /Timed out.*No action was repeated/);
      await assert.rejects(request({ op: "wait", text: "Never appears", hidden: false, timeout: 10001 }), /between 1 and 10000/);
    });

    await t.test("text wait finds a visible duplicate after a hidden first match", async () => {
      await request({ op: "open", url: `${origin}/duplicates` });
      const visible = await request({ op: "wait", text: "Duplicate status", hidden: false, timeout: 200 });
      assert.match(visible.snapshot, /Duplicate status/);
    });

    await t.test("hidden wait refuses success while any duplicate remains visible", async () => {
      await request({ op: "open", url: `${origin}/duplicates` });
      await assert.rejects(request({ op: "wait", text: "Duplicate status", hidden: true, timeout: 200 }), /Timed out waiting for text to become hidden/);
    });

    await t.test("closing a tab during wait reports its real failure rather than a timeout", async () => {
      const parent = await request({ op: "open", url: `${origin}/duplicates` });
      const popup = await click(parent, "Wait popup");
      assert.equal(popup.title, "Closing popup");
      await assert.rejects(request({ op: "wait", text: "Never appears", hidden: false, timeout: 3000 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /Timed out/);
        assert.match(error.message, /closed/i);
        return true;
      });
    });

    await t.test("user input remains responsive while an agent is waiting", async () => {
      await request({ op: "open", url: origin });
      const waiting = assert.rejects(request({ op: "wait", text: "Never appears", hidden: false, timeout: 1500 }), /Timed out/);
      const began = Date.now();
      await request({ op: "input", input: { kind: "key", type: "down", key: "Tab" } });
      await request({ op: "input", input: { kind: "key", type: "up", key: "Tab" } });
      assert.ok(Date.now() - began < 1000, "takeover input does not queue behind the text wait");
      await waiting;
    });

    await t.test("scoped full, interactive and content snapshots keep usable links and redact secrets", async () => {
      const opened = await request({ op: "open", url: `${origin}/scope` });
      assert.doesNotMatch(opened.snapshot, /secret-token/);
      await assert.rejects(request({ op: "type", ref: ref(opened, "Code"), text: "forbidden", snapshotId: opened.snapshotId }), /never type/);
      const afterRefusal = await request({ op: "type", ref: ref(opened, "Note"), text: "still usable", snapshotId: opened.snapshotId });
      assert.match(afterRefusal.snapshot, /still usable/, "refusing a secret field preserves the sibling refs of the approved snapshot");
      const scoped = await request({ op: "snapshot", scope: "#article" });
      assert.match(scoped.snapshot, /Article heading/);
      assert.doesNotMatch(scoped.snapshot, /Outside private text|secret-token/);
      const interactive = await request({ op: "snapshot", scope: "#article", mode: "interactive" });
      assert.doesNotMatch(interactive.snapshot, /heading|Scoped details|secret-token/);
      assert.ok(ref(interactive, "Continue reading"));
      const content = await request({ op: "snapshot", scope: "#article", mode: "content" });
      assert.match(content.snapshot, /Article heading/);
      assert.match(content.snapshot, /Scoped details/);
      assert.match(content.snapshot, /\/url: \/next/);
      assert.doesNotMatch(content.snapshot, /Outside private text|secret-token/);
      assert.deepEqual(Object.values(content.elements).map((element) => element.role), ["link"]);
      const followed = await click(content, "Continue reading");
      assert.equal(followed.title, "Main");
    });

    await t.test("controls past the safety read limit stay unresolved and their values are redacted", async () => {
      const opened = await request({ op: "open", url: `${origin}/many` });
      const code = ref(opened, "Late code");
      assert.equal(opened.elements[code].unresolved, true);
      assert.doesNotMatch(opened.snapshot, /late-secret/);
      await assert.rejects(request({ op: "type", ref: code, text: "forbidden", snapshotId: opened.snapshotId }), /changed since approval/);
    });
  } finally {
    const began = Date.now();
    if (worker.connected) await request({ op: "close" }).catch(() => {});
    if (worker.exitCode === null && worker.signalCode === null) await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const closeTime = Date.now() - began;
    await proxy.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    assert.ok(closeTime < 12_000, "worker closes within the host's 12 second budget");
  }
});
