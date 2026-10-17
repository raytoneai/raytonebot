/**
 * Browser child process (ADR-040). Owns Chromium, its pages and the active page's CDP stream.
 * All model actions use refs from a snapshot bound to one page and revision.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { chromium, errors, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import type { BrowserElement, BrowserRequest, BrowserWorkerMessage, BrowserLaunch } from "./browserProtocol.ts";
import { elementSubmitFacts, enrichmentPlan, secretElement } from "./browserPolicy.ts";

const VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;
const FRAME_INTERVAL_MS = 160;
const FILE_LIMIT = 100 * 1024 * 1024;
const KEYS = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"]);
const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "switch", "slider", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem"]);
const STALE = "The page or target changed since approval. Take a new browser_snapshot before acting; the action was not repeated.";

let launchOptions: BrowserLaunch;
let chrome: ChildProcess | undefined;
let browser: Browser | undefined;
let browserCdp: CDPSession | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let pageCdp: CDPSession | undefined;
let starting: Promise<Page> | undefined;
let closing: Promise<void> | undefined;
let activation = Promise.resolve();
let activationVersion = 0;
let revision = 0;
let screencasting = false;
let frameSeq = 0;
let lastFrameAt = 0;
const frameTimers = new Set<ReturnType<typeof setTimeout>>();
const pages = new Map<Page, string>();
const pendingPopups = new Set<Promise<unknown>>();
const dialogs: string[] = [];
type Shot = { id: string; page: Page; revision: number; elements: Record<string, BrowserElement> };
let lastSnapshot: Shot | undefined;

const send = (message: BrowserWorkerMessage) => { process.send?.(message); };
function invalidate() { revision += 1; lastSnapshot = undefined; }
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function tabs() {
  return Promise.all([...pages].filter(([current]) => !current.isClosed()).map(async ([current, id]) => ({
    id, url: current.url(), title: await current.title().catch(() => ""),
  })));
}

async function reportState() {
  const current = page;
  const atRevision = revision;
  if (!current || current.isClosed()) return;
  const [title, list] = await Promise.all([current.title().catch(() => ""), tabs()]);
  if (page !== current || revision !== atRevision || current.isClosed()) return;
  send({ event: "state", url: current.url(), title, pageId: pages.get(current)!, revision, tabs: list });
}

function clearFrameTimers() {
  for (const timer of frameTimers) clearTimeout(timer);
  frameTimers.clear();
}

async function cast(session: CDPSession) {
  await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
}

/** Set the active page synchronously, then serialize CDP detach/attach. Stale activations cannot win. */
function activate(current: Page): Promise<void> {
  if (current.isClosed()) return Promise.resolve();
  const version = ++activationVersion;
  page = current;
  invalidate();
  activation = activation.catch(() => {}).then(async () => {
    const old = pageCdp;
    pageCdp = undefined;
    clearFrameTimers();
    await old?.detach().catch(() => {});
    if (version !== activationVersion || current.isClosed() || !context) return;
    const session = await context.newCDPSession(current).catch(() => undefined);
    if (!session) return;
    if (version !== activationVersion || current.isClosed()) { await session.detach().catch(() => {}); return; }
    pageCdp = session;
    await current.bringToFront().catch(() => {});
    session.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
      const ack = () => void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (!screencasting || pageCdp !== session || page !== current || version !== activationVersion || current.isClosed()) return ack();
      send({ event: "frame", data, width: metadata.deviceWidth, height: metadata.deviceHeight, pageId: pages.get(current)!, seq: ++frameSeq, capturedAt: Date.now() });
      const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - lastFrameAt));
      lastFrameAt = Date.now() + wait;
      const timer = setTimeout(() => { frameTimers.delete(timer); ack(); }, wait);
      timer.unref();
      frameTimers.add(timer);
    });
    if (screencasting) await cast(session).catch(() => {});
    await reportState();
  });
  return activation;
}

function register(current: Page) {
  if (pages.has(current)) return;
  pages.set(current, randomUUID());
  current.setDefaultTimeout(ACTION_TIMEOUT);
  current.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  void current.setViewportSize(VIEWPORT).catch(() => {});
  current.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 300)}`);
    void dialog.dismiss().catch(() => {});
  });
  current.on("framenavigated", (frame) => {
    if (frame === current.mainFrame() && page === current) { invalidate(); void reportState(); }
  });
  current.on("load", () => void reportState());
  current.on("close", () => {
    pages.delete(current);
    if (page !== current) { void reportState(); return; }
    invalidate();
    const version = ++activationVersion;
    void current.opener().catch(() => null).then(async (opener) => {
      if (version !== activationVersion) return;
      const next = opener && pages.has(opener) && !opener.isClosed() ? opener : [...pages.keys()].find((candidate) => !candidate.isClosed());
      if (next) await activate(next);
      else { page = undefined; await pageCdp?.detach().catch(() => {}); pageCdp = undefined; }
    });
  });
}

async function launch(): Promise<Page> {
  const port = launchOptions.cdpPort ?? await freePort();
  const args = [
    `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${launchOptions.profileDir}`,
    `--proxy-server=http://127.0.0.1:${launchOptions.proxyPort}`, "--proxy-bypass-list=<-loopback>",
    "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--password-store=basic", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-features=Translate,OptimizationHints,MediaRouter",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "about:blank",
  ];
  const [command, ...prefix] = launchOptions.launcher ?? [launchOptions.executable];
  chrome = spawn(command, [...prefix, ...(launchOptions.launcher ? [launchOptions.executable] : []), ...args], { stdio: ["ignore", "ignore", "pipe"], env: launchOptions.env });
  let stderr = "";
  chrome.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  chrome.once("exit", (code) => {
    send({ event: "exit", code }); browser = undefined; context = undefined; page = undefined;
    pages.clear(); invalidate(); clearFrameTimers();
  });
  for (let i = 0; i < 150; i += 1) {
    if (chrome.exitCode !== null) throw new Error(`The browser exited while starting (${chrome.exitCode}). ${stderr.trim().split("\n").at(-1) ?? ""}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 149) throw new Error("The browser did not start within 15 seconds.");
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  context = browser.contexts()[0] ?? await browser.newContext();
  context.on("page", (current) => { register(current); void activate(current); });
  for (const current of context.pages()) register(current);
  const initial = context.pages()[0] ?? await context.newPage();
  await activate(initial);
  browserCdp = await browser.newBrowserCDPSession();
  const knownTargets = new Set((await browserCdp.send("Target.getTargets")).targetInfos.map((target) => target.targetId));
  browserCdp.on("Target.targetCreated", ({ targetInfo }) => {
    if (knownTargets.has(targetInfo.targetId) || targetInfo.type !== "page" || !targetInfo.openerId || !context) return;
    knownTargets.add(targetInfo.targetId);
    const ready = context.waitForEvent("page", { timeout: 5000 }).catch(() => {});
    pendingPopups.add(ready);
    void ready.finally(() => pendingPopups.delete(ready));
  });
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: launchOptions.downloadDir, eventsEnabled: true });
  const downloads = new Map<string, { url: string; name: string }>();
  browserCdp.on("Browser.downloadWillBegin", ({ guid, url, suggestedFilename }) => downloads.set(guid, { url, name: suggestedFilename }));
  browserCdp.on("Browser.downloadProgress", ({ guid, receivedBytes, totalBytes, state }) => {
    const download = downloads.get(guid);
    if (!download) return;
    if (state === "inProgress" && Math.max(receivedBytes, totalBytes) > FILE_LIMIT) {
      void browserCdp?.send("Browser.cancelDownload", { guid }).catch(() => {});
      downloads.delete(guid);
      send({ event: "download", guid, url: download.url, name: download.name, size: Math.max(receivedBytes, totalBytes), state: "too-large" });
    } else if (state === "completed" || state === "canceled") {
      downloads.delete(guid);
      send({ event: "download", guid, url: download.url, name: download.name, size: receivedBytes, state: state === "completed" ? "completed" : "canceled" });
    }
  });
  return page!;
}

async function start(): Promise<Page> {
  if (closing) throw new Error("The browser is closing.");
  if (!browser) {
    starting ??= launch().catch(async (error: unknown) => { await endChrome(); throw error; }).finally(() => { starting = undefined; });
    await starting;
  }
  if (!page || page.isClosed()) {
    const next = [...pages.keys()].find((current) => !current.isClosed()) ?? await context!.newPage();
    await activate(next);
  }
  // Popup/close handlers can replace the activation while an older one is awaited.
  for (;;) {
    const pending = activation;
    await pending;
    if (pending === activation && page && !page.isClosed()) return page;
    if (!page || page.isClosed()) return start();
  }
}

function parseElements(text: string): Record<string, BrowserElement> {
  const elements: Record<string, BrowserElement> = {};
  for (const [line, role, name = "", ref] of text.matchAll(/^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?[^\n]*\[ref=([a-z0-9]+)\]/gm)) {
    elements[ref] = { role, name: name.replace(/\\"/g, "\""), ...(line.includes("[active]") ? { active: true } : {}) };
  }
  return elements;
}

async function summary(options: { scope?: string; mode?: "full" | "interactive" | "content" } = {}) {
  const current = await start();
  const atRevision = revision;
  const region = options.scope ? current.locator(options.scope) : current.locator("body");
  let text = options.scope ? await region.ariaSnapshot({ mode: "ai" }) : await current.ariaSnapshot({ mode: "ai" });
  if (options.mode === "interactive" || options.mode === "content") {
    let keepLink = false;
    text = text.split("\n").filter((line) => {
      const role = /^\s*- ([a-z]+).*\[ref=/.exec(line)?.[1];
      if (role) { keepLink = role === "link"; return options.mode === "content" ? keepLink : INTERACTIVE.has(role); }
      return keepLink && /^\s*- \/url:/.test(line);
    }).join("\n");
  }
  const elements = parseElements(text);
  const plan = enrichmentPlan(elements);
  for (const [, element] of plan.unknown) element.unresolved = true;
  await Promise.all(plan.read.map(async ([ref, element]) => {
    const details = await current.getByRef(ref).evaluate(elementSubmitFacts, undefined, { timeout: 1000 }).catch(() => undefined);
    if (details) Object.assign(element, details);
    else element.unresolved = true;
  }));
  // AI snapshots can include textbox values, including one-time-code fields.
  text = text.split("\n").map((line) => {
    const ref = /\[ref=([a-z0-9]+)\]/.exec(line)?.[1];
    const element = ref ? elements[ref] : undefined;
    const redact = secretElement(element) || (element?.unresolved && ["textbox", "searchbox", "combobox", "spinbutton"].includes(element.role));
    return redact ? line.replace(/(\[ref=[a-z0-9]+\][^:]*)[:].*$/, "$1: [redacted]") : line;
  }).join("\n");
  if (options.mode === "content") {
    const content = await region.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent || !parent.getClientRects().length || parent.closest('script,style,[type="password"],[autocomplete*="one-time-code" i],[autocomplete*="cc-" i],[autocomplete*="password" i]')) continue;
        const text = walker.currentNode.textContent?.trim();
        if (text) parts.push(text);
      }
      return parts.join("\n");
    });
    text = `${content}\n\nLinks:\n${text}`;
  }
  const title = await current.title().catch(() => "");
  // Publish the current revision before the result so a later unchanged state event cannot
  // invalidate the host's newly accepted snapshot.
  await reportState();
  if (page !== current || current.isClosed() || revision !== atRevision) throw new Error(STALE);
  const id = randomUUID();
  lastSnapshot = { id, page: current, revision, elements };
  const notes = dialogs.splice(0).map((dialog) => dialog.startsWith("page answered") ? `The ${dialog}.` : `A ${dialog} (dismissed)`);
  notes.push("Asynchronous content may arrive later; use browser_wait_for for specific text.");
  return { url: current.url(), title, pageId: pages.get(current)!, snapshotId: id, snapshot: text, elements, notes };
}

async function settle() {
  // Browser target discovery precedes Playwright's initialized page event. Drain that event
  // before selecting the page for the result, without adding a delay to ordinary clicks.
  await browserCdp?.send("Target.getTargets").catch(() => {});
  await Promise.all([...pendingPopups]);
  const current = await start();
  await current.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
}

function approvedSnapshot(current: Page, id: string | undefined): Shot {
  const shot = lastSnapshot;
  if (!id || !shot || shot.id !== id || shot.page !== current || page !== current || shot.revision !== revision || current.isClosed()) throw new Error(STALE);
  return shot;
}

async function verifyTarget(current: Page, ref: string, approved: BrowserElement | undefined) {
  if (!approved || approved.unresolved) throw new Error(STALE);
  const locator = current.getByRef(ref);
  // Locator snapshots replace Playwright's ref map for their siblings (even default mode).
  // A full AI read preserves all current node refs; approval still uses the saved facts below.
  const live = parseElements(await current.ariaSnapshot({ mode: "ai" }).catch(() => ""));
  const actual = live[ref];
  if (!actual || actual.role !== approved.role || actual.name !== approved.name) throw new Error(STALE);
  const facts = await locator.evaluate(elementSubmitFacts, undefined, { timeout: 2000 }).catch(() => undefined);
  if (!facts) throw new Error(STALE);
  if (secretElement(facts as BrowserElement)) throw new Error("This field takes a password, code or card number. Agents never type into it; ask the user to take over the browser.");
  for (const key of ["inputType", "autocomplete", "submits", "formMethod"] as const) {
    if (key in approved && approved[key] !== facts[key]) throw new Error(STALE);
  }
}

async function target(current: Page, id: string | undefined, ref: string) {
  const shot = approvedSnapshot(current, id);
  await verifyTarget(current, ref, shot.elements[ref]);
  approvedSnapshot(current, id);
  return shot;
}

async function handle(request: BrowserRequest): Promise<unknown> {
  switch (request.op) {
    case "launch": launchOptions = request.options; return {};
    case "open": {
      const current = await start();
      const url = new URL(request.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) pages can be opened.");
      invalidate();
      const response = await current.goto(url.href, { waitUntil: "domcontentloaded" });
      await settle();
      const status = response?.status() ?? 0;
      if (status >= 400) dialogs.push(`page answered HTTP ${status}${status === 403 && /refused/.test(await current.textContent("body").catch(() => "") ?? "") ? " because RaytoneBot only reaches public websites" : ""}`);
      return summary();
    }
    case "snapshot": return summary(request);
    case "tabs": {
      await start();
      if (!request.pageId) return { pageId: pages.get(page!)!, tabs: await tabs() };
      const selected = [...pages].find(([, id]) => id === request.pageId)?.[0];
      if (!selected || selected.isClosed()) throw new Error("That browser tab is closed or unknown.");
      await activate(selected);
      return summary();
    }
    case "wait": {
      const current = await start();
      if (!request.text || !Number.isFinite(request.timeout) || request.timeout < 1 || request.timeout > 10_000) throw new Error("Wait needs text and a timeout between 1 and 10000 ms.");
      try {
        await current.getByText(request.text, { exact: false }).filter({ visible: true }).first().waitFor({ state: request.hidden ? "hidden" : "visible", timeout: request.timeout });
      } catch (error) {
        if (!(error instanceof errors.TimeoutError)) throw error;
        throw new Error(`Timed out waiting for text to become ${request.hidden ? "hidden" : "visible"}. No action was repeated; take a snapshot or wait again.`);
      }
      if (page !== current || current.isClosed()) throw new Error(STALE);
      return summary();
    }
    case "click": {
      const current = await start();
      await target(current, request.snapshotId, request.ref);
      invalidate();
      await current.getByRef(request.ref).click();
      await settle();
      return summary();
    }
    case "type": {
      const current = await start();
      const shot = await target(current, request.snapshotId, request.ref);
      invalidate();
      const actionRevision = revision;
      await current.getByRef(request.ref).fill(request.text);
      if (request.submit) {
        await verifyTarget(current, request.ref, shot.elements[request.ref]);
        if (page !== current || revision !== actionRevision) throw new Error(STALE);
        await current.getByRef(request.ref).press("Enter");
        await settle();
      }
      return summary();
    }
    case "press": {
      const current = await start();
      if (!KEYS.has(request.key)) throw new Error(`Key not allowed: ${request.key}.`);
      approvedSnapshot(current, request.snapshotId);
      if (request.key === "Enter" || request.key === "Space") {
        if (!request.expectRef) throw new Error(STALE);
        await target(current, request.snapshotId, request.expectRef);
        if (!await current.getByRef(request.expectRef).evaluate((node) => node === document.activeElement || node.contains(document.activeElement), undefined, { timeout: 2000 }).catch(() => false)) {
          throw new Error("Focus moved since the last snapshot. Take a new snapshot before pressing this key.");
        }
      } else if (request.key === "Backspace" || request.key === "Delete") {
        const facts = await current.locator(":focus").evaluate(elementSubmitFacts, undefined, { timeout: 1000 }).catch(() => undefined);
        if (!facts || secretElement(facts as BrowserElement)) throw new Error("Agents never type into secret fields; ask the user to take over the browser.");
      }
      approvedSnapshot(current, request.snapshotId);
      invalidate();
      await current.keyboard.press(request.key === "Space" ? " " : request.key);
      await settle();
      return summary();
    }
    case "scroll": {
      const current = await start();
      invalidate();
      await current.mouse.wheel(0, request.direction === "up" ? -600 : 600);
      return summary();
    }
    case "back": {
      const current = await start();
      invalidate();
      await current.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
      await settle();
      return summary();
    }
    case "screencast": {
      await start();
      if (request.on === screencasting) return {};
      screencasting = request.on;
      if (request.on) await cast(pageCdp!);
      else await pageCdp?.send("Page.stopScreencast").catch(() => {});
      return {};
    }
    case "input": {
      const current = await start();
      if (request.pageId && request.pageId !== pages.get(current)) throw new Error("The active browser tab changed; this input was discarded.");
      invalidate();
      void reportState();
      const input = request.input;
      if (input.kind === "mouse") {
        await current.mouse.move(input.x, input.y);
        if (input.type === "down") await current.mouse.down({ button: input.button ?? "left" });
        if (input.type === "up") await current.mouse.up({ button: input.button ?? "left" });
        if (input.type === "wheel") await current.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
      } else if (input.kind === "key") {
        if (input.type === "down") await current.keyboard.down(input.key);
        else await current.keyboard.up(input.key);
      } else await current.keyboard.insertText(input.text);
      return {};
    }
    case "close": {
      await endChrome();
      setTimeout(() => process.exit(0), 50).unref();
      return {};
    }
  }
}

let requests = Promise.resolve();
let manualRequests = Promise.resolve();
process.on("message", (message: { id: number; request: BrowserRequest }) => {
  const answer = () => handle(message.request).then(
    (result) => send({ id: message.id, ok: true, result }),
    (error: unknown) => send({ id: message.id, ok: false, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 500) : String(error) }),
  );
  if (message.request.op === "close") void answer();
  else if (["input", "tabs", "screencast"].includes(message.request.op)) manualRequests = manualRequests.then(answer, answer);
  else requests = requests.then(answer, answer);
});

async function within(promise: Promise<void>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
  } finally { clearTimeout(timer); }
}

/** Single flight: CDP graceful exit gets 5s; TERM and KILL keep the total below 9s. */
function endChrome(): Promise<void> {
  closing ??= (async () => {
    clearFrameTimers();
    const current = chrome;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    if (browser?.isConnected()) {
      void browser.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => {});
      if (await within(gone, 5000)) return;
    }
    current.kill("SIGTERM");
    if (await within(gone, 2000)) return;
    current.kill("SIGKILL");
    await within(gone, 1000);
  })();
  return closing;
}

process.on("disconnect", () => { void endChrome().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void endChrome().finally(() => process.exit(0)); });
