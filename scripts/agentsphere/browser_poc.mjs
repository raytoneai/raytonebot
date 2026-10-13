// Browser proof of concept, run INSIDE a throwaway sandbox by browser_poc.py (not part of the app).
// Measures Chromium headless shell under a separate UID, driven over CDP by playwright-core:
// install size, whether Chrome's own sandbox works in this kernel, memory (RSS and PSS) idle and
// on real pages, screencast frame rate and CPU, and a download. Prints one JSON object.
import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const SHELL = process.env.POC_SHELL;
const USER = "raytone-browser";
const PROFILE = "/home/raytone-browser/profile";
const DOWNLOADS = "/home/raytone-browser/downloads";
const PAGES = ["https://en.wikipedia.org/wiki/Web_browser", "https://github.com/microsoft/playwright"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command) => { try { return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { return `ERR ${String(error.stderr || error.message).trim().slice(0, 300)}`; } };

/**
 * The browser's whole process tree: RSS adds shared pages once per process, PSS shares them out.
 * The browser runs as another UID, so /proc is read through one sudo call. A process that is gone
 * is skipped; any other read failure, or nothing measured at all, makes the sample invalid.
 */
function memory(root) {
  const rows = sh("ps -e -o pid=,ppid=").split("\n").map((line) => line.trim().split(/\s+/));
  const children = new Map();
  for (const [pid, ppid] of rows) (children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(pid);
  const tree = new Set([String(root)]);
  for (const stack = [String(root)]; stack.length;) for (const child of children.get(stack.pop()) ?? []) if (!tree.has(child)) { tree.add(child); stack.push(child); }
  const script = [...tree].map((pid) => `if [ -d /proc/${pid} ]; then echo "== ${pid}"; cat /proc/${pid}/smaps_rollup /proc/${pid}/stat || echo "!! ${pid}"; else echo "-- ${pid}"; fi`).join("; ");
  let output;
  try { output = execSync("sudo sh -c " + JSON.stringify(script), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { return { valid: false, error: `sudo read failed: ${String(error.stderr || error.message).trim().slice(0, 200)}` }; }
  let rss = 0, pss = 0, cpuTicks = 0, measured = 0, exited = 0;
  const failed = new Set();
  for (const block of output.split(/^(?===|--|!!)/m)) {
    const pid = block.slice(3).split("\n")[0].trim();
    if (block.startsWith("--")) { exited += 1; continue; }
    if (block.startsWith("!!")) { failed.add(pid); continue; }
    if (!block.startsWith("==")) continue;
    const rssKB = /^Rss:\s+(\d+)/m.exec(block)?.[1], pssKB = /^Pss:\s+(\d+)/m.exec(block)?.[1];
    // From the state field on (field 3); the command name may hold spaces or ")".
    const statLine = block.split("\n").find((line) => line.startsWith(`${pid} (`));
    const stat = statLine?.slice(statLine.lastIndexOf(")") + 2).split(" ");
    if (rssKB === undefined || pssKB === undefined || !stat) { failed.add(pid); continue; }
    rss += Number(rssKB); pss += Number(pssKB);
    cpuTicks += Number(stat[11]) + Number(stat[12]); // utime, stime: fields 14 and 15
    measured += 1;
  }
  const valid = measured > 0 && failed.size === 0;
  return { valid, processes: measured, exited, ...(failed.size ? { unreadable: [...failed] } : {}),
    ...(valid ? { rssMB: Math.round(rss / 1024), pssMB: Math.round(pss / 1024), cpuSeconds: +(cpuTicks / 100).toFixed(2) } : {}) };
}

/** Starts the browser as its own UID and connects over CDP. Any failure stops what was started
 *  and comes back as `{ error }`, so the caller can try the next variant. */
async function launch(extra) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--password-store=basic",
    `--user-data-dir=${PROFILE}`, ...extra, "about:blank"];
  const child = spawn("sudo", ["-u", USER, "-H", SHELL, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const cleanup = () => { sh(`sudo pkill -KILL -u ${USER}`); child.kill("SIGKILL"); };
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i += 1) {
      if (child.exitCode !== null) throw new Error(`exited with ${child.exitCode}`);
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch {}
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error("no CDP endpoint within 15 s");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
    // sudo is the child; the browser is its child.
    const root = sh(`pgrep -P ${child.pid} -n`);
    if (!/^\d+$/.test(root)) { await browser.close().catch(() => {}); throw new Error(`browser process not found under sudo (${root})`); }
    return { browser, root, stop: async () => { await browser.close().catch(() => {}); cleanup(); } };
  } catch (error) {
    cleanup();
    await sleep(500);
    return { error: `${error instanceof Error ? error.message : String(error)}; stderr: ${stderr.trim().slice(-500)}` };
  }
}

const report = {
  machine: { nproc: sh("nproc"), memory: sh("free -m | sed -n 2p"), disk: sh("df -h / | tail -1"), kernel: sh("uname -r"), os: sh(". /etc/os-release && echo $PRETTY_NAME") },
  install: { shellDirMB: Number(sh(`du -sm ${SHELL.split("/").slice(0, -1).join("/")} | cut -f1`)), playwrightCoreMB: Number(sh("du -sm node_modules/playwright-core | cut -f1")) },
  userNamespaces: { maxUserNamespaces: sh("cat /proc/sys/user/max_user_namespaces"), unprivilegedClone: sh("cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo absent"),
    apparmorRestrict: sh("cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent") },
};

// 1. Does Chrome's own sandbox start here, or does isolation rest on the UID and firewall alone?
let session = await launch([]);
report.chromeSandbox = session.error ? { works: false, error: session.error } : { works: true };
if (session.error) session = await launch(["--no-sandbox"]);
if (session.error) { report.fatal = session.error; console.log(JSON.stringify(report, null, 2)); process.exit(1); }

try {
  const context = session.browser.contexts()[0] ?? await session.browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(2000);
  report.memoryIdle = memory(session.root);
  report.pages = [];
  for (const url of PAGES) {
    const started = Date.now();
    try { await page.goto(url, { waitUntil: "load", timeout: 45_000 }); } catch (error) { report.pages.push({ url, error: String(error.message).slice(0, 200) }); continue; }
    await sleep(3000);
    const snapshot = await page.locator("body").ariaSnapshot().catch((error) => `ERR ${error.message}`);
    report.pages.push({ url, loadMs: Date.now() - started, snapshotChars: snapshot.length, ...memory(session.root) });
  }

  // 2. Live view: CDP screencast on the GitHub page for 5 s, as the Output panel would watch it.
  const cdp = await context.newCDPSession(page);
  let frames = 0, bytes = 0;
  cdp.on("Page.screencastFrame", async ({ data, sessionId }) => { frames += 1; bytes += data.length * 0.75; await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); });
  const before = memory(session.root);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  for (let i = 0; i < 10; i += 1) { await page.mouse.wheel(0, 300); await sleep(500); }
  await cdp.send("Page.stopScreencast");
  const after = memory(session.root);
  report.screencast = { seconds: 5, frames, avgFrameKB: frames ? Math.round(bytes / frames / 1024) : 0, memory: after,
    ...(before.valid && after.valid ? { browserCpuSeconds: +(after.cpuSeconds - before.cpuSeconds).toFixed(2) } : { browserCpuSeconds: null }) };

  // 3. A download lands in the browser user's directory, never under the bot's data.
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS }).catch((error) => { report.downloadSetup = String(error.message); });
  await page.setContent(`<a id="d" href="data:text/plain;base64,${Buffer.from("hello from the sandbox browser\n").toString("base64")}" download="poc.txt">get</a>`);
  await page.click("#d");
  await sleep(2000);
  report.download = { files: existsSync(DOWNLOADS) ? readdirSync(DOWNLOADS) : sh(`sudo ls ${DOWNLOADS}`) };

  // 4. Profile size after visiting two public pages only: no login, backup or restore here.
  report.profileMB = Number(sh(`sudo du -sm ${PROFILE} | cut -f1`));
  report.profileCacheMB = Number(sh(`sudo du -smc ${PROFILE}/Default/Cache ${PROFILE}/Default/Code\\ Cache 2>/dev/null | tail -1 | cut -f1`));
} catch (error) {
  report.fatal = `measurement failed: ${error instanceof Error ? error.message : String(error)}`;
} finally {
  await session.stop();
}
// A sample that could not be read is a failed run, never a zero.
const samples = [report.memoryIdle, ...(report.pages ?? []).filter((page) => !page.error), report.screencast?.memory].filter(Boolean);
report.invalidSamples = samples.filter((sample) => sample.valid === false).length;
console.log(JSON.stringify(report, null, 2));
process.exit(report.fatal || report.invalidSamples ? 1 : 0);
