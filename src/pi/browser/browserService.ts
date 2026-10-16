import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HostTools } from "../memories.ts";
import { agentIsolationEnabled, requireAgentIsolation } from "../runtime/agentProcess.ts";
import type { UserQuestion } from "../../runtime/userInput.ts";
import type { AgentPresetId } from "../harnessCatalog.ts";
import { BROWSER_TOOL_SPECS } from "./browserTools.ts";
import { classifyBrowserCall } from "./browserPolicy.ts";
import type { BrowserElement, BrowserInput, BrowserLaunch, BrowserPageSummary, BrowserRequest, BrowserViewState, BrowserWorkerMessage } from "./browserProtocol.ts";
import { startEgressProxy, type EgressProxy } from "./egressProxy.ts";

/**
 * The bot's one browser (ADR-040): starts the egress proxy and the worker on first use, stops
 * them after a quiet spell, serializes agent actions, streams frames only to watchers, hands
 * control to the user and back, and files downloads into the workspace.
 */

const IDLE_MS = 10 * 60_000;
/** The snapshot an action returns; browser_snapshot pages through the rest. */
const SNAPSHOT_CHARS = 8000;
const PAGE_CHARS = 15_000;
const SESSION_DOWNLOAD_LIMIT = 500 * 1024 * 1024;
const EXECUTABLE = /\.(exe|msi|dmg|pkg|app|sh|bash|zsh|command|bat|cmd|ps1|psm1|vbs|jar|apk|deb|rpm|appimage|bin|run|com|scr|so|dylib|dll)$/i;
const SANDBOX = { user: "raytone-browser", home: "/home/raytone-browser", proxyPort: 5191, cdpPort: 5192 };

export type BrowserToolContext = {
  conversationId: string;
  agent: AgentPresetId;
  /** Files a download into the agent's own workspace (`downloads/`), safely; returns its path. */
  saveDownload(name: string, bytes: Buffer): Promise<string>;
  ask(questions: UserQuestion[], signal?: AbortSignal): Promise<Record<string, string[]> | null>;
};

/** Chromium headless shell: RAYTONEBOT_BROWSER_PATH, else the newest one Playwright installed. */
export function findHeadlessShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.RAYTONEBOT_BROWSER_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")]
    .filter((root): root is string => Boolean(root) && existsSync(root!));
  for (const root of roots) {
    const builds = readdirSync(root).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const build of builds) {
      for (const platform of readdirSync(join(root, build))) {
        const candidate = join(root, build, platform, "chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** In the sandbox the browser starts only behind its own UID and firewall (setup_isolation.py). */
function requireBrowserIsolation() {
  requireAgentIsolation();
  const marker = JSON.parse(readFileSync("/etc/raytonebot-isolation.json", "utf8")) as { browserUser?: string; browserPorts?: number[] };
  if (marker.browserUser !== SANDBOX.user || marker.browserPorts?.[0] !== SANDBOX.proxyPort || marker.browserPorts?.[1] !== SANDBOX.cdpPort) {
    throw new Error("Browser isolation is not configured; deploy again to install it.");
  }
}

/** What a download's first bytes say it is: a program is never filed into the workspace. */
function executableFile(body: Buffer, name: string): boolean {
  if (EXECUTABLE.test(name)) return true;
  const magic = body.subarray(0, 4).toString("hex");
  return magic.startsWith("4d5a") || magic === "7f454c46" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic) || body.subarray(0, 2).toString() === "#!";
}

/** The takeover card speaks the language the agent wrote its reason in (the user's). */
function takeoverLabels(reason: string) {
  if (/[\u3040-\u30ff]/.test(reason)) return { header: "ブラウザー", done: "完了しました", doneDetail: "ブラウザーでの操作が終わりました", skip: "スキップ", skipDetail: "代わらずに続ける" };
  if (/[\u4e00-\u9fff]/.test(reason)) return { header: "浏览器", done: "已完成", doneDetail: "我已在浏览器里处理好", skip: "跳过", skipDetail: "不接管，继续" };
  return { header: "Browser", done: "Done", doneDetail: "I finished in the browser", skip: "Skip", skipDetail: "Continue without it" };
}

function safeName(name: string): string {
  const cleaned = basename(name).replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "download";
}

export function createBrowserService(options: { dataDir: string; log?(event: string, fields: Record<string, unknown>): void;
  /** Tests only: treat this path as the installed headless shell instead of searching for one. */
  executable?: string;
  /** Tests only: let the proxy reach a local test server. */
  allowAddress?: (address: string) => boolean; allowPort?: (port: number) => boolean }) {
  const sandboxed = agentIsolationEnabled();
  const executable = options.executable ?? findHeadlessShell();
  const stateFile = join(options.dataDir, "browser.json");
  const localDir = join(options.dataDir, "browser");
  let loggedIn = new Set<string>();
  try { loggedIn = new Set((JSON.parse(readFileSync(stateFile, "utf8")) as { loggedIn?: string[] }).loggedIn ?? []); } catch { /* none yet */ }

  let worker: ChildProcess | undefined;
  let proxy: EgressProxy | undefined;
  let starting: Promise<void> | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let queue: Promise<unknown> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | undefined;
  const state: BrowserViewState = { available: Boolean(executable), ...(executable ? {} : { reason: "Chromium headless shell is not installed on this host." }), running: false, controller: "agent" };
  let elements: Record<string, BrowserElement> = {};
  let snapshotText = "";
  let downloadedBytes = 0;
  let takeoverOrigins = new Set<string>();
  let streaming = false;
  /** Where the agent acting now files its downloads. */
  let currentSave: BrowserToolContext["saveDownload"] | undefined;
  const watchers = new Set<(event: { type: "state"; state: BrowserViewState } | { type: "frame"; data: string; width: number; height: number }) => void>();
  const notes: string[] = [];

  /** The innermost focused element of the latest snapshot (a page with nothing focused marks its root). */
  const focusedRef = () => Object.keys(elements).filter((ref) => elements[ref].active).at(-1);
  const origin = () => { try { return state.url ? new URL(state.url).origin : undefined; } catch { return undefined; } };
  const publish = () => { for (const watch of watchers) watch({ type: "state", state: { ...state } }); };
  const saveLoggedIn = () => {
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ loggedIn: [...loggedIn] }, null, 2), { mode: 0o600 });
  };

  const requestTo = (target: ChildProcess | undefined, body: BrowserRequest) => new Promise<unknown>((resolve, reject) => {
    if (!target?.connected) return reject(new Error("The browser is not running."));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    target.send({ id, request: body });
  });
  const request = (body: BrowserRequest) => requestTo(worker, body);
  const exited = (child: ChildProcess, ms: number) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), ms); child.once("exit", () => { clearTimeout(timer); resolve(true); }); });

  /** sudo does not pass SIGKILL on, so the browser UID's processes are ended directly: TERM first,
   *  so Chrome reaps its own renderers, then KILL whatever is left after a moment. */
  const stopChrome = async () => {
    if (!sandboxed) return;
    const signal = (name: string) => { try { execFileSync("/usr/bin/sudo", ["-n", "/usr/bin/pkill", `-${name}`, "-u", SANDBOX.user], { stdio: "ignore" }); return true; } catch { return false; } };
    if (!signal("TERM")) return;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { execFileSync("/usr/bin/pgrep", ["-u", SANDBOX.user], { stdio: "ignore" }); } catch { return; }
    }
    signal("KILL");
  };

  const stop = async () => {
    clearTimeout(idleTimer);
    const current = worker;
    // Close through the worker first (it ends Chrome and waits for it), and only then let go of it.
    if (current?.connected) await Promise.race([requestTo(current, { op: "close" }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]);
    worker = undefined;
    if (current && !await exited(current, 2000)) {
      current.kill("SIGTERM");
      if (!await exited(current, 1500)) current.kill("SIGKILL");
    }
    await stopChrome();
    await proxy?.close();
    proxy = undefined;
    state.running = false;
    streaming = false;
    state.controller = "agent";
    delete state.requested;
    publish();
    options.log?.("browser.stopped", {});
  };

  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!watchers.size && state.controller === "agent") void stop(); else touch(); }, IDLE_MS);
    idleTimer.unref();
  };

  /** As the browser UID in the sandbox: whatever its downloads directory holds (even a planted
   *  symlink) can only reach what that UID could already read, never the bot's own files. */
  const asBrowser = (command: string, ...args: string[]) => execFileSync("/usr/bin/sudo", ["-n", "-u", SANDBOX.user, "--", command, ...args], { maxBuffer: 110 * 1024 * 1024 });

  const fileDownload = async (message: Extract<BrowserWorkerMessage, { event: "download" }>, staging: string) => {
    const name = safeName(message.name);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(message.guid)) { notes.push(`The download ${name} was refused: unexpected id.`); return; }
    const source = join(staging, message.guid);
    const drop = () => { try { if (sandboxed) asBrowser("/usr/bin/rm", "-f", "--", source); else rmSync(source, { force: true }); } catch { /* gone */ } };
    if (message.state === "too-large") { notes.push(`The download ${name} was stopped: it is over 100 MB.`); drop(); return; }
    if (message.state === "canceled") { notes.push(`The download ${name} was cancelled.`); drop(); return; }
    try {
      const body = sandboxed ? asBrowser("/usr/bin/cat", "--", source) : readFileSync(source);
      drop();
      if (body.length > 100 * 1024 * 1024) { notes.push(`The download ${name} was discarded: it is over 100 MB.`); return; }
      if (downloadedBytes + body.length > SESSION_DOWNLOAD_LIMIT) { notes.push(`The download ${name} was discarded: this browser session already downloaded 500 MB.`); return; }
      if (executableFile(body, name)) { notes.push(`The download ${name} looks like a program and was not kept.`); options.log?.("browser.download_blocked", { name }); return; }
      if (!currentSave) { notes.push(`The download ${name} was discarded: no workspace for it.`); return; }
      const file = await currentSave(name, body);
      downloadedBytes += body.length;
      notes.push(`Downloaded ${name} (${body.length < 1024 ? `${body.length} bytes` : `${Math.round(body.length / 1024)} KB`}) to ${file}.`);
      options.log?.("browser.downloaded", { bytes: body.length });
    } catch (error) {
      drop();
      notes.push(`The download ${name} could not be saved: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  };

  const start = () => starting ??= (async () => {
    if (!executable) throw new Error(state.reason);
    if (sandboxed) requireBrowserIsolation();
    proxy = await startEgressProxy({ port: sandboxed ? SANDBOX.proxyPort : 0, proxyFakeIp: !sandboxed, allowAddress: options.allowAddress, allowPort: options.allowPort, log: options.log });
    const staging = sandboxed ? join(SANDBOX.home, "downloads") : join(localDir, "downloads");
    const launch: BrowserLaunch = sandboxed
      ? { executable, launcher: ["/usr/bin/sudo", "-n", "-u", SANDBOX.user, "--", "/usr/bin/setpriv", "--no-new-privs"],
        profileDir: join(SANDBOX.home, "profile"), downloadDir: staging, proxyPort: proxy.port, cdpPort: SANDBOX.cdpPort }
      : { executable, profileDir: join(localDir, "profile"), downloadDir: staging, proxyPort: proxy.port,
        env: { PATH: process.env.PATH ?? "", HOME: homedir() } };
    if (!sandboxed) { mkdirSync(launch.profileDir, { recursive: true, mode: 0o700 }); mkdirSync(staging, { recursive: true, mode: 0o700 }); }
    const child = fork(fileURLToPath(new URL("./browserWorker.ts", import.meta.url)), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
    worker = child;
    child.on("message", (message: BrowserWorkerMessage) => {
      if ("id" in message) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiter?.resolve(message.result); else waiter?.reject(new Error(message.error));
      } else if (message.event === "frame") {
        for (const watch of watchers) watch({ type: "frame", data: message.data, width: message.width, height: message.height });
      } else if (message.event === "state") {
        state.url = message.url; state.title = message.title;
        if (state.controller === "user") { const now = origin(); if (now?.startsWith("http")) takeoverOrigins.add(now); }
        publish();
      } else if (message.event === "download") void fileDownload(message, staging);
      else if (message.event === "exit") { options.log?.("browser.exited", { code: message.code }); void stop(); }
    });
    child.once("exit", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("The browser worker stopped."));
      pending.clear();
      if (worker === child) void stop();
    });
    await request({ op: "launch", options: launch });
    state.running = true;
    publish();
    options.log?.("browser.started", { sandboxed });
  })().finally(() => { starting = undefined; });

  /** One agent action at a time, never while the user holds the browser. A run that was stopped
   *  while its action waited in the queue never starts it: approval is not a licence to act after
   *  the turn it belonged to has ended. */
  const act = (body: BrowserRequest, signal?: AbortSignal) => {
    const run = queue.then(async () => {
      if (signal?.aborted) signal.throwIfAborted();
      if (state.controller === "user") throw new Error("The user is controlling the browser right now. Wait for them to hand it back, then take a new snapshot.");
      if (!worker?.connected) await start();
      // Starting the browser awaited: check again before the action leaves the host.
      if (signal?.aborted) signal.throwIfAborted();
      touch();
      const result = await request(body);
      await stream();
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  /** Frames flow while someone watches and the browser runs; the first action starts it. */
  const stream = async () => {
    const want = watchers.size > 0;
    if (!worker?.connected || want === streaming) return;
    streaming = want;
    await request({ op: "screencast", on: want }).catch(() => { streaming = !want; });
  };

  const release = () => {
    if (state.controller !== "user") return;
    state.controller = "agent";
    // A site the user visited while in control may now be signed in as them.
    for (const site of takeoverOrigins) loggedIn.add(site);
    takeoverOrigins.clear();
    try { saveLoggedIn(); } catch (error) { options.log?.("browser.state_save_failed", { error: String(error) }); }
    // The page changed under the user's hands: refs must come from a new snapshot.
    elements = {};
    publish();
  };

  const describe = (summary: BrowserPageSummary, limit: number, offset = 0) => {
    elements = summary.elements;
    snapshotText = summary.snapshot;
    state.url = summary.url; state.title = summary.title;
    const part = summary.snapshot.slice(offset, offset + limit);
    const more = offset + limit < summary.snapshot.length ? `\n[Snapshot characters ${offset}–${offset + part.length} of ${summary.snapshot.length}. Call browser_snapshot with offset=${offset + part.length} for more.]` : "";
    return [`URL: ${summary.url}`, `Title: ${summary.title}`, ...summary.notes, ...notes.splice(0), "", part + more].join("\n");
  };

  return {
    view: (): BrowserViewState => ({ ...state }),

    /** The approval class of a browser call from the host's own snapshot (policy hook). */
    classify: (name: string, args: unknown) => classifyBrowserCall(name, args, { elements, origin: origin(), loggedIn, focused: elements[focusedRef() ?? ""] }),

    toolsFor(context: BrowserToolContext): HostTools | undefined {
      if (!executable) return undefined;
      return {
        specs: BROWSER_TOOL_SPECS,
        async run(name, args, signal) {
          const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
          currentSave = context.saveDownload;
          try {
            switch (name) {
              case "browser_open": return { text: describe(await act({ op: "open", url: String(input.url ?? "") }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              case "browser_snapshot": {
                const offset = Number.isInteger(input.offset) && (input.offset as number) > 0 ? input.offset as number : 0;
                const summary = offset && snapshotText ? { url: state.url ?? "", title: state.title ?? "", snapshot: snapshotText, elements, notes: [] } : await act({ op: "snapshot" }, signal) as BrowserPageSummary;
                return { text: describe(summary, PAGE_CHARS, offset), isError: false };
              }
              case "browser_click": return { text: describe(await act({ op: "click", ref: String(input.ref ?? "") }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              case "browser_type": {
                return { text: describe(await act({ op: "type", ref: String(input.ref ?? ""), text: String(input.text ?? ""), submit: input.submit === true }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              }
              case "browser_press": {
                const key = String(input.key ?? "");
                // The same focused element the approval was judged on, or the worker refuses.
                const expectRef = key === "Enter" || key === "Space" ? focusedRef() : undefined;
                return { text: describe(await act({ op: "press", key, ...(expectRef ? { expectRef } : {}) }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              }
              case "browser_scroll": return { text: describe(await act({ op: "scroll", direction: input.direction === "up" ? "up" : "down" }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              case "browser_back": return { text: describe(await act({ op: "back" }, signal) as BrowserPageSummary, SNAPSHOT_CHARS), isError: false };
              case "browser_request_takeover": {
                if (!worker?.connected) await start();
                const reason = String(input.reason ?? "").trim().slice(0, 300) || "The agent needs you in the browser.";
                state.requested = { reason };
                publish();
                const labels = takeoverLabels(reason);
                const answer = await context.ask([{ id: "browser_takeover", header: labels.header, question: reason,
                  options: [{ label: labels.done, description: labels.doneDetail }, { label: labels.skip, description: labels.skipDetail }], multiSelect: false, allowOther: false }], signal)
                  .finally(() => { delete state.requested; publish(); });
                // Answering also hands the browser back.
                release();
                const done = answer?.browser_takeover?.[0] === labels.done;
                return { text: done ? `The user finished and handed the browser back. Take a new snapshot before acting. ${notes.splice(0).join(" ")}`.trim() : "The user skipped taking over. Continue without it, or explain what you need.", isError: false };
              }
            }
            return { text: `Unknown browser tool: ${name}.`, isError: true };
          } catch (error) {
            return { text: error instanceof Error ? error.message : String(error), isError: true };
          }
        },
      };
    },

    /** The user takes the browser: agent actions wait until it is handed back. */
    async takeover() {
      if (!state.available) throw new Error(state.reason);
      if (!worker?.connected) await start();
      await queue;
      state.controller = "user";
      takeoverOrigins = new Set(origin()?.startsWith("http") ? [origin()!] : []);
      touch();
      publish();
      await stream();
    },
    release,
    /** Input from the live view, only while the user holds the browser. */
    async input(input: BrowserInput) {
      if (state.controller !== "user") throw new Error("Take over the browser first.");
      touch();
      await request({ op: "input", input });
    },
    /** A watcher of the live view; frames flow only while at least one is watching. */
    watch(listener: Parameters<typeof watchers.add>[0]) {
      watchers.add(listener);
      listener({ type: "state", state: { ...state } });
      void stream();
      return () => { watchers.delete(listener); void stream(); };
    },
    stop,
  };
}

export type BrowserService = ReturnType<typeof createBrowserService>;
