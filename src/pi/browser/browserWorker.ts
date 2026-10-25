/**
 * Browser child process (ADR-040). Owns Chromium, its pages and the active page's CDP stream.
 * All model actions use refs from a snapshot bound to one page and revision.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, errors, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Frame, type JSHandle, type Page } from "playwright-core";

import type { BrowserElement, BrowserRequest, BrowserWorkerMessage, BrowserLaunch } from "./browserProtocol.ts";
import { elementSubmitFacts, enrichmentPlan, secretElement } from "./browserPolicy.ts";
import { createBrowserRedactor } from "./browserRedaction.ts";

const VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;
const FRAME_INTERVAL_MS = 160;
const FILE_LIMIT = 100 * 1024 * 1024;
const KEYS = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"]);
const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "switch", "slider", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem", "iframe"]);
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
const pressedKeys = new Map<Page, Set<string>>();
const pressedButtons = new Map<Page, Set<"left" | "right" | "middle">>();
async function resetInput() {
  for (const [page, keys] of pressedKeys) for (const key of keys) await page.keyboard.up(key).catch(() => {});
  for (const [page, buttons] of pressedButtons) {
    // Releasing on the original button could submit it after the viewer disconnected.
    await page.mouse.move(-1, -1).catch(() => {});
    for (const button of buttons) await page.mouse.up({ button }).catch(() => {});
  }
  pressedKeys.clear(); pressedButtons.clear();
}
let frameSeq = 0;
let confirmedInput: { page: Page; id: string; capturedAt: number } | undefined;
let lastFrameAt = 0;
const frameTimers = new Set<ReturnType<typeof setTimeout>>();
const pages = new Map<Page, string>();
const pageOwners = new Map<Page, string>();
const framePages = new Map<string, Page>();
const frameObservers = new Map<Page, Promise<CDPSession | undefined>>();
const downloads = new Map<string, { url: string; name: string; owner?: string; blocked?: boolean }>();
const pendingPopups = new Set<Promise<unknown>>();
const dialogs: string[] = [];
let settleNote: string | undefined;
const frameRevisions = new WeakMap<Frame, number>();
type Shot = { id: string; page: Page; revision: number; elements: Record<string, BrowserElement>; frames: Map<Frame, number> };
function checkFrame(shot: Shot, frame: Frame) {
  if (frame.isDetached() || shot.frames.get(frame) !== (frameRevisions.get(frame) ?? 0)) throw new Error(STALE);
}
let lastSnapshot: Shot | undefined;
type VaultCapture = { token: string; shot: Shot; origin: string; password: ElementHandle; username?: ElementHandle; filled: Set<string> };
let vaultCapture: VaultCapture | undefined;
const vaultSecrets = new Set<string>();
const sensitivePages = new Map<Page, JSHandle>();
async function isSensitive(current: Page): Promise<boolean> {
  const document = sensitivePages.get(current);
  if (!document) return false;
  if (await document.evaluate(doc => doc === window.document).catch(() => false)) return true;
  sensitivePages.delete(current);
  void document.dispose().catch(() => {});
  return false;
}
const redact = createBrowserRedactor(vaultSecrets);
function releaseVaultCapture() {
  const previous = vaultCapture;
  vaultCapture = undefined;
  void previous?.password.dispose().catch(() => {});
  void previous?.username?.dispose().catch(() => {});
}


const send = (message: BrowserWorkerMessage) => { process.send?.(message); };
/** Keep callbacks only while a page or an in-flight GUID can still use them. */
function releaseDownloadOwner(owner?: string) {
  if (!owner || [...pageOwners.values()].includes(owner) || [...downloads.values()].some(download => download.owner === owner)) return;
  send({ event: "download-owner-released", owner });
}
function setPageOwner(current: Page, owner?: string) {
  const previous = pageOwners.get(current);
  if (owner) pageOwners.set(current, owner); else pageOwners.delete(current);
  if (previous !== owner) releaseDownloadOwner(previous);
}

/** Observe frames for the page's lifetime, including newly attached background frames. */
async function observeFrames(current: Page): Promise<CDPSession | undefined> {
  const session = await context!.newCDPSession(current).catch(() => undefined);
  if (!session) return;
  if (current.isClosed()) { void session.detach().catch(() => {}); return; }
  session.on("Page.frameAttached", ({ frameId }) => framePages.set(frameId, current));
  session.on("Page.frameNavigated", ({ frame }) => framePages.set(frame.id, current));
  session.on("Page.frameDetached", ({ frameId }) => framePages.delete(frameId));
  await session.send("Page.enable").catch(() => {});
  const tree = await session.send("Page.getFrameTree").catch(() => undefined);
  if (!current.isClosed() && tree) {
    // A navigation request invalidates an approved login before its response commits. In
    // particular, a username input handler must not navigate then receive the password
    // during a slow response. Child-frame navigation does not invalidate top-level refs.
    const mainFrameId = tree.frameTree.frame.id;
    const navigationStarted = ({ frameId }: { frameId: string }) => {
      if (page === current && frameId === mainFrameId && vaultCapture?.shot.page === current) {
        invalidate(); void reportState();
      }
    };
    session.on("Page.frameRequestedNavigation", navigationStarted);
    session.on("Page.frameStartedNavigating", navigationStarted);
    const bind = (node: { frame: { id: string }; childFrames?: typeof node[] }) => {
      framePages.set(node.frame.id, current);
      for (const child of node.childFrames ?? []) bind(child);
    };
    bind(tree.frameTree);
  }
  return session;
}
function invalidate() { revision += 1; lastSnapshot = undefined; releaseVaultCapture(); }
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

const pageTitles = new Map<Page, string>();
const titleReads = new Map<Page, Promise<string>>();
/** A download navigation can leave DOM title reads pending until all bytes arrive. */
async function pageTitle(current: Page): Promise<string> {
  let reading = titleReads.get(current);
  if (!reading) {
    const url = current.url();
    reading = current.title().then(title => {
      if (!current.isClosed() && current.url() === url) pageTitles.set(current, title);
      return pageTitles.get(current) ?? "";
    }, () => pageTitles.get(current) ?? "");
    titleReads.set(current, reading);
    void reading.finally(() => { if (titleReads.get(current) === reading) titleReads.delete(current); });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([reading, new Promise<string>(resolve => { timer = setTimeout(() => resolve(pageTitles.get(current) ?? ""), 250); })]); }
  finally { clearTimeout(timer); }
}

async function tabs() {
  return Promise.all([...pages].filter(([current]) => !current.isClosed()).map(async ([current, id]) => ({
    id, url: current.url(), title: await pageTitle(current),
  })));
}

async function reportState() {
  const current = page;
  const atRevision = revision;
  if (!current || current.isClosed()) return;
  const [title, list] = await Promise.all([pageTitle(current), tabs()]);
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
    await resetInput();
    const old = pageCdp;
    pageCdp = undefined;
    clearFrameTimers();
    // Chromium can defer detach until a download navigation finishes. Stale-session
    // handlers are already guarded; do not hold the new tab behind the old transport.
    void old?.send("Page.stopScreencast").catch(() => {});
    void old?.detach().catch(() => {});
    if (version !== activationVersion || current.isClosed() || !context) return;
    const session = await context.newCDPSession(current).catch(() => undefined);
    if (!session) return;
    if (version !== activationVersion || current.isClosed()) { void session.detach().catch(() => {}); return; }
    pageCdp = session;
    await frameObservers.get(current);
    await session.send("Page.enable").catch(() => {});
    if (version !== activationVersion || current.isClosed()) return;
    await current.bringToFront().catch(() => {});
    session.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
      const ack = () => void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (!screencasting || pageCdp !== session || page !== current || version !== activationVersion || current.isClosed()) return ack();
      const capturedAt = metadata.timestamp ? Math.round(metadata.timestamp * 1000) : Date.now();
      const inputId = confirmedInput?.page === current && capturedAt >= confirmedInput.capturedAt ? confirmedInput.id : undefined;
      send({ event: "frame", data, width: metadata.deviceWidth, height: metadata.deviceHeight, pageId: pages.get(current)!, seq: ++frameSeq, capturedAt, inputId });
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
  frameObservers.set(current, observeFrames(current));
  current.setDefaultTimeout(ACTION_TIMEOUT);
  current.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  void current.setViewportSize(VIEWPORT).catch(() => {});
  current.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 300)}`);
    void dialog.dismiss().catch(() => {});
  });
  current.on("framenavigated", (frame) => {
    frameRevisions.set(frame, (frameRevisions.get(frame) ?? 0) + 1);
    if (page === current && frame === current.mainFrame()) { invalidate(); void reportState(); }
  });
  current.on("load", () => void reportState());
  current.on("popup", (popup) => {
    const owner = pageOwners.get(current);
    if (owner) setPageOwner(popup, owner);
  });
  current.on("close", () => {
    void sensitivePages.get(current)?.dispose().catch(() => {}); sensitivePages.delete(current); pages.delete(current); pageTitles.delete(current); titleReads.delete(current); pressedKeys.delete(current); pressedButtons.delete(current);
    setPageOwner(current);
    void frameObservers.get(current)?.then(session => session?.detach().catch(() => {}));
    frameObservers.delete(current);
    for (const [id, ownerPage] of framePages) if (ownerPage === current) framePages.delete(id);
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

function waitForPopup(targetId: string) {
  const owner = context!;
  const discovery = browserCdp!;
  const ready = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      owner.off("page", inspect);
      discovery.off("Target.targetDestroyed", destroyed);
      resolve();
    };
    const inspect = async (current: Page) => {
      const session = await owner.newCDPSession(current).catch(() => undefined);
      if (!session) return;
      try { if ((await session.send("Target.getTargetInfo")).targetInfo.targetId === targetId) finish(); }
      catch { /* A closing unrelated page cannot satisfy this popup. */ }
      finally { await session.detach().catch(() => {}); }
    };
    const destroyed = (event: { targetId: string }) => { if (event.targetId === targetId) finish(); };
    const timer = setTimeout(finish, 5000);
    owner.on("page", inspect);
    discovery.on("Target.targetDestroyed", destroyed);
    // Playwright's page event can precede target discovery; include pages already initialized.
    for (const current of owner.pages()) void inspect(current);
  });
  pendingPopups.add(ready);
  void ready.finally(() => pendingPopups.delete(ready));
}

async function launch(): Promise<Page> {
  // Merge existing preferences; never replace saved profile settings. Unreadable profiles
  // are left intact (sandbox deployments provision the preferences as the browser UID).
  const preferences = join(launchOptions.profileDir, "Default", "Preferences");
  const patch = (source: string) => {
    const prefs = JSON.parse(source || "{}") as Record<string, any>;
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    prefs.autofill = { ...prefs.autofill, credit_card_enabled: false };
    return JSON.stringify(prefs);
  };
  try {
    mkdirSync(join(launchOptions.profileDir, "Default"), { recursive: true, mode: 0o700 });
    let source = "{}";
    try { source = readFileSync(preferences, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    writeFileSync(preferences, patch(source), { mode: 0o600 });
  } catch {
    // Do not overwrite unreadable/malformed existing preferences. Chrome flags below also
    // disable autofill UI; sandbox deployments should provision these profile preferences.
  }

  const port = launchOptions.cdpPort ?? await freePort();
  const args = [
    ...(launchOptions.testOnlyCertificateSpki && /^[A-Za-z0-9+/]{43}=$/.test(launchOptions.testOnlyCertificateSpki) ? [`--ignore-certificate-errors-spki-list=${launchOptions.testOnlyCertificateSpki}`] : []),
    `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${launchOptions.profileDir}`,
    `--proxy-server=http://127.0.0.1:${launchOptions.proxyPort}`, "--proxy-bypass-list=<-loopback>",
    "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--password-store=basic", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-features=Translate,OptimizationHints,MediaRouter,PasswordManagerOnboarding,AutofillServerCommunication,AutofillEnableAccountWalletStorage",
    "--disable-save-password-bubble",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "about:blank",
  ];
  const [command, ...prefix] = launchOptions.launcher ?? [launchOptions.executable];
  chrome = spawn(command, [...prefix, ...(launchOptions.launcher ? [launchOptions.executable] : []), ...args], { stdio: ["ignore", "ignore", "pipe"], env: launchOptions.env });
  let stderr = "";
  chrome.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  chrome.once("exit", (code) => {
    send({ event: "exit", code }); browser = undefined; context = undefined; page = undefined;
    pages.clear(); pageOwners.clear(); framePages.clear(); frameObservers.clear(); downloads.clear(); invalidate(); clearFrameTimers();
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
    waitForPopup(targetInfo.targetId);
  });
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: launchOptions.downloadDir, eventsEnabled: true });
  browserCdp.on("Browser.downloadWillBegin", ({ guid, url, suggestedFilename, frameId }) => {
    const source = framePages.get(frameId);
    // Credential-bearing documents cannot turn an input event into a workspace artifact.
    // Keep the GUID until Chromium finishes cancellation so the staging file is discarded.
    if (source && sensitivePages.has(source)) {
      downloads.set(guid, { url: "", name: "Login Vault page download", blocked: true });
      void browserCdp?.send("Browser.cancelDownload", { guid }).catch(() => {});
      return;
    }
    const download = { url, name: suggestedFilename, owner: source ? pageOwners.get(source) : undefined };
    downloads.set(guid, download);
    send({ event: "download", guid, ...download, size: 0, state: "started" });
  });
  browserCdp.on("Browser.downloadProgress", ({ guid, receivedBytes, totalBytes, state }) => {
    const download = downloads.get(guid);
    if (!download) return;
    if (download.blocked) {
      if (state === "completed" || state === "canceled") {
        downloads.delete(guid);
        send({ event: "download", guid, url: "", name: "Login Vault page download", size: receivedBytes, state: "canceled" });
      }
      return;
    }
    if (state === "inProgress" && Math.max(receivedBytes, totalBytes) > FILE_LIMIT) {
      void browserCdp?.send("Browser.cancelDownload", { guid }).catch(() => {});
      downloads.delete(guid);
      send({ event: "download", guid, ...download, size: Math.max(receivedBytes, totalBytes), state: "too-large" });
      releaseDownloadOwner(download.owner);
    } else if (state === "completed" || state === "canceled") {
      downloads.delete(guid);
      send({ event: "download", guid, ...download, size: receivedBytes, state: state === "completed" ? "completed" : "canceled" });
      releaseDownloadOwner(download.owner);
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

async function summary(options: { scope?: string; frameRef?: string; snapshotId?: string; mode?: "full" | "interactive" | "content" } = {}) {
  const current = await start();
  const atRevision = revision;
  const frames = new Map(current.frames().map(frame => [frame, frameRevisions.get(frame) ?? 0]));
  if (await isSensitive(current)) {
    await reportState();
    if (page !== current || revision !== atRevision || current.isClosed()) throw new Error(STALE);
    const id = randomUUID();
    lastSnapshot = { id, page: current, revision, elements: {}, frames };
    dialogs.splice(0);
    return { url: new URL(current.url()).origin, title: "[Login Vault page hidden]", pageId: pages.get(current)!, snapshotId: id, snapshot: "Page content is hidden after Login Vault fill. Ask the user to take over to review and submit the login.", elements: {}, notes: [] };
  }
  const frameScopeError = "Frame-scoped snapshots require frameRef from the latest snapshot, not a frame selector in scope.";
  if (options.scope && /(?:^|>>)\s*internal:control\s*=\s*enter-frame(?:\s*(?:>>|$))/i.test(options.scope)) throw new Error(frameScopeError);
  let selectedFrame = current.mainFrame();
  if (options.frameRef) {
    const shot = approvedSnapshot(current, options.snapshotId);
    if (shot.elements[options.frameRef]?.role !== "iframe") throw new Error("frameRef must identify an iframe in the latest snapshot.");
    const handle = await current.getByRef(options.frameRef).elementHandle();
    try {
      const frame = await handle?.contentFrame();
      if (!frame || frame.isDetached()) throw new Error(STALE);
      checkFrame(shot, frame);
      selectedFrame = frame;
      approvedSnapshot(current, options.snapshotId);
    } finally { await handle?.dispose(); }
  }
  const region = selectedFrame.locator(options.scope || "body");
  if (options.scope && await region.evaluate(el => /^(IFRAME|FRAME)$/.test(el.tagName))) throw new Error(frameScopeError);
  let text = options.scope || options.frameRef ? await region.ariaSnapshot({ mode: "ai" }) : await current.ariaSnapshot({ mode: "ai" });
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
  let content: string | undefined;
  if (options.mode === "content") {
    content = await region.evaluate((root) => {
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
  }
  const title = await pageTitle(current);
  // Publish the current revision before the result so a later unchanged state event cannot
  // invalidate the host's newly accepted snapshot.
  await reportState();
  if (page !== current || current.isClosed() || revision !== atRevision) throw new Error(STALE);
  const id = randomUUID();
  const shot = { id, page: current, revision, elements, frames };
  for (const frame of frames.keys()) checkFrame(shot, frame);
  if (current.frames().some(frame => !frames.has(frame))) throw new Error(STALE);
  lastSnapshot = shot;
  const notes = dialogs.splice(0).map((dialog) => dialog.startsWith("page answered") ? `The ${dialog}.` : `A ${dialog} (dismissed)`);
  if (settleNote) { notes.push(settleNote); settleNote = undefined; }
  if (current.frames().length > 1) notes.push("Embedded frames use their own refs. Use browser_snapshot with frameRef to focus inside an iframe; never substitute a parent-page target.");
  if (selectedFrame !== current.mainFrame()) notes.push(`Frame URL: ${selectedFrame.url()}`);
  notes.push("Asynchronous content may arrive later; use browser_wait_for for specific text.");
  // The trusted host retains credential history across worker restarts and redacts the
  // model response. Keep internal URLs and element facts intact for binding and approval.
  return { url: current.url(), title, pageId: pages.get(current)!, snapshotId: id, snapshot: text, ...(content !== undefined ? { content } : {}), elements, notes };
}

async function settle() {
  settleNote = undefined;
  // Browser target discovery precedes Playwright's initialized page event. Drain that event
  // before selecting the page for the result, without adding a delay to ordinary clicks.
  await browserCdp?.send("Target.getTargets").catch(() => {});
  await Promise.all([...pendingPopups]);
  const current = await start();
  await current.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  // Observe rendering rather than network idleness: SSE and polling can stay open forever.
  const quiet = await current.evaluate(() => new Promise<boolean>((resolve) => {
    let idle: ReturnType<typeof setTimeout>;
    const finish = (quiet: boolean) => { observer.disconnect(); clearTimeout(idle); clearTimeout(limit); resolve(quiet); };
    const changed = () => { clearTimeout(idle); idle = setTimeout(() => finish(true), 200); };
    const observer = new MutationObserver(changed);
    const limit = setTimeout(() => finish(false), 1000);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    changed();
  })).catch(() => false);
  if (!quiet) settleNote = "The DOM did not settle within 1 second. This is a current snapshot, not confirmation the action finished; use browser_wait_for for its expected result. Do not repeat the action.";
}

function approvedSnapshot(current: Page, id: string | undefined): Shot {
  const shot = lastSnapshot;
  if (!id || !shot || shot.id !== id || shot.page !== current || page !== current || shot.revision !== revision || current.isClosed()) throw new Error(STALE);
  return shot;
}

async function verifyTarget(current: Page, ref: string, approved: BrowserElement | undefined, shot: Shot) {
  if (!approved || approved.unresolved) throw new Error(STALE);
  const locator = current.getByRef(ref);
  // Role/name matching uses Playwright's accessible-name algorithm without rebuilding its ref map.
  const sameTarget = locator.and(current.getByRole(approved.role as Parameters<Page["getByRole"]>[0], { name: approved.name, exact: true }));
  if (await sameTarget.count().catch(() => 0) !== 1) throw new Error(STALE);
  const handle = await locator.elementHandle({ timeout: 2000 });
  const frame = await handle?.ownerFrame();
  if (!handle || !frame) throw new Error(STALE);
  let facts;
  try {
    checkFrame(shot, frame);
    facts = await handle.evaluate(elementSubmitFacts).catch(() => undefined);
    checkFrame(shot, frame);
  } finally { await handle.dispose(); }
  if (!facts) throw new Error(STALE);
  if (secretElement(facts as BrowserElement)) throw new Error("This field takes a password, code or card number. Agents never type into it; ask the user to take over the browser.");
  for (const key of ["inputType", "autocomplete", "submits", "formMethod", "origin"] as const) {
    if (key in approved && approved[key] !== facts[key]) throw new Error(STALE);
  }
}

async function target(current: Page, id: string | undefined, ref: string) {
  const shot = approvedSnapshot(current, id);
  await verifyTarget(current, ref, shot.elements[ref], shot);
  approvedSnapshot(current, id);
  return shot;
}

/** Follow the browser's actual focus chain, including cross-origin nested frames. */
async function focusedFrame(current: Page): Promise<Frame> {
  let frame = current.mainFrame();
  for (;;) {
    const handle = await frame.evaluateHandle(() => document.activeElement);
    try {
      const child = await handle.asElement()?.contentFrame();
      if (!child) return frame;
      frame = child;
    } finally { await handle.dispose(); }
  }
}

/** Runs in the top-level document. Validation and assignment share a JS turn so a
 * ref cannot be rebound between checking it and filling. Page event handlers still see input;
 * a user-approved website is necessarily trusted with the credential being entered. */
function loginField(node: Element, args: { field: "username" | "password"; origin: string; value?: string }) {
  const input = node as HTMLInputElement;
  if (window !== window.top || input.ownerDocument !== document || !input.isConnected || location.origin !== args.origin || input.tagName !== "INPUT" || input.disabled || input.readOnly || !input.getClientRects().length) return false;
  const autocomplete = (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  if (args.field === "password") {
    if (input.type !== "password" || !autocomplete.includes("current-password") || autocomplete.some(part => part === "new-password" || part === "one-time-code" || part.startsWith("cc-"))) return false;
  } else if (!["text", "email"].includes(input.type) || autocomplete.some(part => /password|one-time-code|^cc-/.test(part))) return false;
  if (args.value !== undefined) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(input, args.value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

async function captureLogin(request: Extract<BrowserRequest, { op: "vault-capture" }>) {
  const current = await start();
  const shot = approvedSnapshot(current, request.snapshotId);
  const url = new URL(current.url());
  const localTest = launchOptions.testOnlyAllowHttpLoopbackVault === true && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localTest) || url.origin !== request.origin || pages.get(current) !== request.pageId) throw new Error(STALE);
  releaseVaultCapture();
  const handles: ElementHandle[] = [];
  try {
    const field = async (ref: string, kind: "username" | "password") => {
      const approved = shot.elements[ref];
      if (!approved || approved.unresolved) throw new Error(STALE);
      const locator = current.getByRef(ref);
      if (await locator.and(current.getByRole(approved.role as Parameters<Page["getByRole"]>[0], { name: approved.name, exact: true })).count() !== 1) throw new Error(STALE);
      const handle = await locator.elementHandle();
      if (!handle) throw new Error(STALE);
      handles.push(handle);
      if (!await handle.evaluate(loginField, { field: kind, origin: request.origin })) throw new Error("Login Vault requires an ordinary username and an explicit current-password field.");
      return handle;
    };
    const password = await field(request.passwordRef, "password");
    const username = request.usernameRef ? await field(request.usernameRef, "username") : undefined;
    approvedSnapshot(current, request.snapshotId);
    vaultCapture = { token: randomUUID(), shot, origin: request.origin, password, username, filled: new Set() };
    return { token: vaultCapture.token };
  } catch (error) {
    for (const handle of handles) void handle.dispose().catch(() => {});
    throw error;
  }
}

/** Recheck the original captured nodes without recapturing refs or entering any values. */
async function validateLogin(token: string) {
  const captured = vaultCapture;
  if (!captured || captured.token !== token || captured.filled.size) throw new Error(STALE);
  approvedSnapshot(captured.shot.page, captured.shot.id);
  if (new URL(captured.shot.page.url()).origin !== captured.origin) throw new Error(STALE);
  for (const field of ["username", "password"] as const) {
    const handle = captured[field];
    if (handle && !await handle.evaluate(loginField, { field, origin: captured.origin })) throw new Error(STALE);
  }
  approvedSnapshot(captured.shot.page, captured.shot.id);
  return {};
}

async function fillLoginField(request: Extract<BrowserRequest, { op: "vault-fill-field" }>) {
  const captured = vaultCapture;
  if (!captured || captured.token !== request.token || captured.filled.has(request.field)) throw new Error(STALE);
  approvedSnapshot(captured.shot.page, captured.shot.id);
  if (new URL(captured.shot.page.url()).origin !== captured.origin) throw new Error(STALE);
  const handle = captured[request.field];
  if (!handle) throw new Error(STALE);
  if (request.value) vaultSecrets.add(request.value);
  setPageOwner(captured.shot.page);
  if (!await isSensitive(captured.shot.page)) sensitivePages.set(captured.shot.page, await captured.shot.page.evaluateHandle(() => document));
  approvedSnapshot(captured.shot.page, captured.shot.id);
  if (!await handle.evaluate(loginField, { field: request.field, origin: captured.origin, value: request.value })) throw new Error(STALE);
  captured.filled.add(request.field);
  approvedSnapshot(captured.shot.page, captured.shot.id);
  return {};
}

/** User-facing screencast is separate: model images must not expose a filled login document. */
async function modelScreenshot(id: string) {
  const current = await start();
  approvedSnapshot(current, id);
  const secretSelector = 'input[type="password"],[autocomplete*="one-time-code" i],[autocomplete*="cc-" i],[autocomplete*="password" i]';
  const check = async () => {
    const shot = approvedSnapshot(current, id);
    for (const frame of shot.frames.keys()) checkFrame(shot, frame);
    if (current.frames().some(frame => !shot.frames.has(frame))) throw new Error(STALE);
    if (await isSensitive(current)) throw new Error("Screenshots are hidden after Login Vault fill. Ask the user to take over.");
    for (const frame of current.frames()) {
      const filled = await frame.locator(secretSelector).evaluateAll(nodes => nodes.some(node => Boolean((node as HTMLInputElement).value || (node as HTMLElement).isContentEditable && node.textContent))).catch(() => true);
      if (filled) throw new Error("Screenshots are unavailable while secret fields contain values. Use a text snapshot or user takeover.");
    }
    for (const frame of shot.frames.keys()) checkFrame(shot, frame);
    if (current.frames().some(frame => !shot.frames.has(frame))) throw new Error(STALE);
    approvedSnapshot(current, id);
  };
  await check();
  const bytes = await current.screenshot({ type: "jpeg", quality: 70, fullPage: false, timeout: 5000,
    mask: current.frames().map(frame => frame.locator(secretSelector)) });
  await check();
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Browser screenshot exceeds the 2 MiB image limit.");
  return { mimeType: "image/jpeg", data: bytes.toString("base64") };
}

async function handle(request: BrowserRequest): Promise<unknown> {
  const ownDownloads = (current: Page) => {
    setPageOwner(current, request.downloadOwner);
  };
  switch (request.op) {
    case "vault-capture": return captureLogin(request);
    case "vault-validate": return validateLogin(request.token);
    case "vault-fill-field": return fillLoginField(request);
    case "vault-finish": if (vaultCapture?.token === request.token) invalidate(); return {};
    case "reset-input": await resetInput(); return {};
    case "launch": launchOptions = request.options; return {};
    case "clear-download-owners": for (const current of pageOwners.keys()) setPageOwner(current); return {};
    case "open": {
      const current = await start();
      const url = new URL(request.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) pages can be opened.");
      ownDownloads(current);
      invalidate();
      const response = await current.goto(url.href, { waitUntil: "domcontentloaded" });
      await settle();
      const status = response?.status() ?? 0;
      if (status >= 400) dialogs.push(`page answered HTTP ${status}${status === 403 && /refused/.test(await current.textContent("body").catch(() => "") ?? "") ? " because RaytoneBot only reaches public websites" : ""}`);
      return summary();
    }
    case "snapshot": return summary(request);
    case "screenshot": return modelScreenshot(request.snapshotId);
    case "tabs": {
      await start();
      if (!request.pageId) return { pageId: pages.get(page!)!, tabs: await Promise.all((await tabs()).map(async tab => {
        const current = [...pages].find(([, id]) => id === tab.id)?.[0];
        const hidden = current ? await isSensitive(current) : true;
        return { ...tab, title: hidden ? "[Login Vault page hidden]" : tab.title, url: hidden ? new URL(tab.url).origin : tab.url };
      })) };
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
      ownDownloads(current);
      invalidate();
      await current.getByRef(request.ref).click();
      await settle();
      return summary();
    }
    case "type": {
      const current = await start();
      const shot = await target(current, request.snapshotId, request.ref);
      ownDownloads(current);
      invalidate();
      const actionRevision = revision;
      await current.getByRef(request.ref).fill(request.text);
      if (request.submit) {
        await verifyTarget(current, request.ref, shot.elements[request.ref], shot);
        if (page !== current || revision !== actionRevision) throw new Error(STALE);
        await current.getByRef(request.ref).press("Enter");
      }
      await settle();
      return summary();
    }
    case "press": {
      const current = await start();
      if (!KEYS.has(request.key)) throw new Error(`Key not allowed: ${request.key}.`);
      const shot = approvedSnapshot(current, request.snapshotId);
      if (["Enter", "Space", "Backspace", "Delete"].includes(request.key)) {
        if (!request.expectRef) throw new Error(STALE);
        await target(current, request.snapshotId, request.expectRef);
        const focus = await focusedFrame(current);
        checkFrame(shot, focus);
        const handle = await current.getByRef(request.expectRef).elementHandle();
        try { if (await handle?.ownerFrame() !== focus) throw new Error(STALE); }
        finally { await handle?.dispose(); }
        if (!await current.getByRef(request.expectRef).evaluate((node) => node === document.activeElement || node.contains(document.activeElement), undefined, { timeout: 2000 }).catch(() => false)) {
          throw new Error("Focus moved since the last snapshot. Take a new snapshot before pressing this key.");
        }
      }
      approvedSnapshot(current, request.snapshotId);
      ownDownloads(current);
      invalidate();
      await current.keyboard.press(request.key === "Space" ? " " : request.key);
      await settle();
      return summary();
    }
    case "scroll": {
      const current = await start();
      ownDownloads(current);
      invalidate();
      await current.mouse.wheel(0, request.direction === "up" ? -600 : 600);
      await settle();
      return summary();
    }
    case "back": {
      const current = await start();
      ownDownloads(current);
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
      ownDownloads(current);
      invalidate();
      void reportState();
      confirmedInput = undefined;
      const input = request.input;
      if (input.kind === "mouse") {
        await current.mouse.move(input.x, input.y);
        if (input.type === "down") {
          await current.mouse.down({ button: input.button ?? "left" });
          const held = pressedButtons.get(current) ?? new Set(); held.add(input.button ?? "left"); pressedButtons.set(current, held);
        }
        if (input.type === "up") { await current.mouse.up({ button: input.button ?? "left" }); pressedButtons.get(current)?.delete(input.button ?? "left"); }
        if (input.type === "wheel") await current.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
      } else if (input.kind === "key") {
        if (input.type === "down") {
          await current.keyboard.down(input.key);
          const held = pressedKeys.get(current) ?? new Set(); held.add(input.key); pressedKeys.set(current, held);
        } else { await current.keyboard.up(input.key); pressedKeys.get(current)?.delete(input.key); }
      } else await current.keyboard.insertText(input.text);
      // An input receipt needs a frame captured after dispatch, not an arbitrary in-flight
      // screencast frame. One per client batch, only while the view is watched.
      if (request.inputId && screencasting) {
        await within(current.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 250).catch(() => false);
        if (page === current && !current.isClosed()) {
          const capturedAt = Date.now();
          const data = await current.screenshot({ type: "jpeg", quality: 65, timeout: 2000 });
          if (page === current && !current.isClosed()) {
            confirmedInput = { page: current, id: request.inputId, capturedAt };
            send({ event: "frame", data: data.toString("base64"), ...VIEWPORT, seq: ++frameSeq, capturedAt, pageId: pages.get(current)!, inputId: request.inputId });
          }
        }
      }
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
  const answer = () => handle(message.request).finally(() => releaseDownloadOwner(message.request.downloadOwner)).then(
    (result) => send({ id: message.id, ok: true, result }),
    (error: unknown) => send({ id: message.id, ok: false, error: message.request.op.startsWith("vault-") ? "Login Vault target is invalid or fill failed. Take a new snapshot and approve again." : redact(error instanceof Error ? error.message.split("\n")[0].slice(0, 500) : String(error)) }),
  );
  if (message.request.op === "close") void answer();
  else if (["input", "tabs", "screencast", "reset-input"].includes(message.request.op)) manualRequests = manualRequests.then(answer, answer);
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
