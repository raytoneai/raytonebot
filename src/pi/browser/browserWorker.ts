/**
 * The browser worker (ADR-040), a child process of the bot that exists only while the browser is
 * in use, so Playwright's memory is not held the rest of the time. It launches Chromium, optionally
 * inside Xvfb, as the `raytone-browser` UID behind the sandbox egress proxy, connects
 * over CDP and answers the host's requests on the IPC channel. It holds no credentials and never
 * runs page JavaScript chosen by a model.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

import type { BrowserElement, BrowserRequest, BrowserWorkerMessage, BrowserLaunch } from "./browserProtocol.ts";
import { elementSubmitFacts, enrichmentPlan } from "./browserPolicy.ts";

const VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;
/** A frame at most this often: the live view is for watching and taking over, not video. */
const FRAME_INTERVAL_MS = 160;
const FILE_LIMIT = 100 * 1024 * 1024;
const KEYS = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"]);

let launchOptions: BrowserLaunch;
let chrome: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let pageCdp: CDPSession | undefined;
let screencasting = false;
let lastFrameAt = 0;
const dialogs: string[] = [];

const send = (message: BrowserWorkerMessage) => process.send?.(message);

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

async function start(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // The sandbox firewall lets the browser UID answer on this one port only; locally any port does.
  const port = launchOptions.cdpPort ?? await freePort();
  const args = [
    `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${launchOptions.profileDir}`,
    `--proxy-server=http://127.0.0.1:${launchOptions.proxyPort}`,
    // Loopback is otherwise bypassed; through the proxy it is refused like any private address.
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    // Avoid a host keyring; device-bound sessions may still require login after migration.
    "--password-store=basic", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-features=Translate,OptimizationHints,MediaRouter",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "about:blank",
  ];
  const [command, ...prefix] = launchOptions.launcher ?? [launchOptions.executable];
  chrome = spawn(command, [...prefix, ...(launchOptions.launcher ? [launchOptions.executable] : []), ...args], { stdio: ["ignore", "ignore", "pipe"], env: launchOptions.env });
  let stderr = "";
  chrome.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  chrome.once("exit", (code) => { send({ event: "exit", code }); browser = undefined; page = undefined; });
  for (let i = 0; i < 150; i += 1) {
    if (chrome.exitCode !== null) throw new Error(`The browser exited while starting (${chrome.exitCode}). ${stderr.trim().split("\n").at(-1) ?? ""}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 149) throw new Error("The browser did not start within 15 seconds.");
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const context = browser.contexts()[0] ?? await browser.newContext();
  page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize(VIEWPORT);
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  // A page's dialogs never wait for anyone: they are dismissed and reported with the next result.
  page.on("dialog", (dialog) => { dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 300)}`); void dialog.dismiss().catch(() => {}); });
  page.on("framenavigated", (frame) => { if (frame === page?.mainFrame()) void reportState(); });
  page.on("load", () => void reportState());
  pageCdp = await context.newCDPSession(page);
  pageCdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    const ack = () => void pageCdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!screencasting) return ack();
    send({ event: "frame", data, width: metadata.deviceWidth, height: metadata.deviceHeight });
    // Acknowledging later slows Chrome down to the frame interval instead of dropping frames.
    const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - lastFrameAt));
    lastFrameAt = Date.now() + wait;
    setTimeout(ack, wait);
  });
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: launchOptions.downloadDir, eventsEnabled: true });
  const downloads = new Map<string, { url: string; name: string }>();
  browserCdp.on("Browser.downloadWillBegin", ({ guid, url, suggestedFilename }) => downloads.set(guid, { url, name: suggestedFilename }));
  browserCdp.on("Browser.downloadProgress", ({ guid, receivedBytes, totalBytes, state }) => {
    const download = downloads.get(guid);
    if (!download) return;
    if (state === "inProgress" && Math.max(receivedBytes, totalBytes) > FILE_LIMIT) {
      void browserCdp.send("Browser.cancelDownload", { guid }).catch(() => {});
      downloads.delete(guid);
      send({ event: "download", guid, url: download.url, name: download.name, size: Math.max(receivedBytes, totalBytes), state: "too-large" });
    } else if (state === "completed" || state === "canceled") {
      downloads.delete(guid);
      send({ event: "download", guid, url: download.url, name: download.name, size: receivedBytes, state: state === "completed" ? "completed" : "canceled" });
    }
  });
  await reportState();
  return page;
}

async function reportState() {
  if (!page || page.isClosed()) return;
  send({ event: "state", url: page.url(), title: await page.title().catch(() => "") });
}

/** The AI snapshot plus what the host needs to judge an action before it runs: per ref, its role
 *  and name, and for inputs and buttons what they submit and whether they take a secret. */
async function snapshot(current: Page): Promise<{ text: string; elements: Record<string, BrowserElement> }> {
  const text = await current.ariaSnapshot({ mode: "ai" });
  const elements: Record<string, BrowserElement> = {};
  const lines = [...text.matchAll(/^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?[^\n]*\[ref=([a-z0-9]+)\]/gm)];
  for (const [line, role, name = "", ref] of lines) elements[ref] = { role, name: name.replace(/\\"/g, "\""), ...(line.includes("[active]") ? { active: true } : {}) };
  const plan = enrichmentPlan(elements);
  // Past the read limit there are no facts to judge with: mark them unknown so approval asks
  // instead of treating a late POST button as an ordinary click.
  for (const [, element] of plan.unknown) element.unresolved = true;
  await Promise.all(plan.read.map(async ([ref, element]) => {
    // The page reads its own attributes: a button's `formmethod` and the form's default submit
    // button decide the real method, so approval never trusts the form's declared one alone.
    const details = await current.getByRef(ref).evaluate(elementSubmitFacts, undefined, { timeout: 1000 }).catch(() => undefined);
    // Facts that never arrived cannot be judged (the element went away, or the read timed out):
    // approval must ask instead of assuming an ordinary click, and the policy sees the marker.
    if (details) Object.assign(element, details);
    else element.unresolved = true;
  }));
  return { text, elements };
}

async function summary(current: Page) {
  const shot = await snapshot(current);
  const notes = dialogs.splice(0).map((dialog) => dialog.startsWith("page answered") ? `The ${dialog}.` : `A ${dialog} (dismissed)`);
  return { url: current.url(), title: await current.title().catch(() => ""), snapshot: shot.text, elements: shot.elements, notes };
}

async function settle(current: Page) {
  await current.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await current.waitForTimeout(400);
}

/** A field that takes a password, a one-time code or card details: never typed into by an agent. */
async function secretField(current: Page, ref: string) {
  return current.getByRef(ref).evaluate((node) => {
    const el = node as HTMLInputElement;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    return type === "password" || /one-time-code|cc-|current-password|new-password/.test(autocomplete);
  }, undefined, { timeout: 2000 }).catch(() => false);
}

async function handle(request: BrowserRequest): Promise<unknown> {
  switch (request.op) {
    case "launch": launchOptions = request.options; return {};
    case "open": {
      const current = await start();
      const url = new URL(request.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) pages can be opened.");
      const response = await current.goto(url.href, { waitUntil: "domcontentloaded" });
      await settle(current);
      const status = response?.status() ?? 0;
      if (status >= 400) dialogs.push(`page answered HTTP ${status}${status === 403 && /refused/.test(await current.textContent("body").catch(() => "") ?? "") ? " because RaytoneBot only reaches public websites" : ""}`);
      return summary(current);
    }
    case "snapshot": return summary(await start());
    case "click": {
      const current = await start();
      await current.getByRef(request.ref).click();
      await settle(current);
      return summary(current);
    }
    case "type": {
      const current = await start();
      if (await secretField(current, request.ref)) throw new Error("This field takes a password, code or card number. Agents never type into it; ask the user to take over the browser.");
      await current.getByRef(request.ref).fill(request.text);
      if (request.submit) { await current.getByRef(request.ref).press("Enter"); await settle(current); }
      return summary(current);
    }
    case "press": {
      const current = await start();
      if (!KEYS.has(request.key)) throw new Error(`Key not allowed: ${request.key}.`);
      // Approved against the element focused in the snapshot: if focus moved since, refuse.
      if (request.expectRef && !await current.getByRef(request.expectRef).evaluate((node) => node === document.activeElement || node.contains(document.activeElement), undefined, { timeout: 2000 }).catch(() => false)) {
        throw new Error("Focus moved since the last snapshot. Take a new snapshot before pressing this key.");
      }
      await current.keyboard.press(request.key === "Space" ? " " : request.key);
      await settle(current);
      return summary(current);
    }
    case "scroll": {
      const current = await start();
      await current.mouse.wheel(0, request.direction === "up" ? -600 : 600);
      await current.waitForTimeout(300);
      return summary(current);
    }
    case "back": {
      const current = await start();
      await current.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
      await settle(current);
      return summary(current);
    }
    case "screencast": {
      const current = await start();
      if (request.on === screencasting) return {};
      screencasting = request.on;
      if (request.on) await pageCdp!.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
      else await pageCdp!.send("Page.stopScreencast").catch(() => {});
      void current;
      return {};
    }
    case "input": {
      const current = await start();
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
      setTimeout(() => process.exit(0), 50);
      return {};
    }
  }
}

process.on("message", (message: { id: number; request: BrowserRequest }) => {
  handle(message.request).then(
    (result) => send({ id: message.id, ok: true, result }),
    (error: unknown) => send({ id: message.id, ok: false, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 500) : String(error) }),
  );
});
/** Chrome is this process's child: it must be gone before the worker exits, or it is orphaned. */
async function endChrome() {
  const current = chrome;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => current.once("exit", () => resolve()));
  // Playwright's close() only disconnects a CDP-attached browser. Ask Chrome itself to exit
  // before terminating xvfb-run, or losing the display can discard recent profile writes.
  if (browser?.isConnected()) {
    await Promise.race([
      browser.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (await Promise.race([gone.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))])) return;
  }
  current.kill("SIGTERM");
  if (await Promise.race([gone.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))])) return;
  current.kill("SIGKILL");
  await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

process.on("disconnect", () => { void endChrome().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void endChrome().finally(() => process.exit(0)); });
