import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HANDOFF_PATH, issueHandoff, newHandoffSecret } from "../scripts/handoff.mjs";
import { agentSphere, botGet, botOrigin, type Platform } from "./agentsphere.ts";
import { currentUser, devLoginActive } from "./auth.ts";
import { isBackingUp, keeperTick, nextRoutineFire, POLICY, startBackup, type KeeperContext } from "./keeper.ts";
import { provision, runProcess, type ProvisionContext } from "./provision.ts";
import { readAccess, Store, writeAccess, type BotRecord } from "./store.ts";

/**
 * The Raytone control service (ADR-041): the welcome page where a signed-in user claims a bot and
 * enters it, and the always-on keeper that wakes, renews and backs up its sandbox. It lives outside
 * every sandbox because it holds the AgentSphere key, which never enters one.
 *
 *   node control/server.ts                      serve (CONTROL_* settings below)
 *   node control/server.ts import --owner ID    adopt the sandbox in .agentsphere/ for user ID
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "control", "public");
const config = {
  host: process.env.CONTROL_HOST ?? "127.0.0.1",
  port: Number(process.env.CONTROL_PORT ?? 5199),
  dataDir: process.env.CONTROL_DATA_DIR ?? join(homedir(), ".raytone-control"),
  template: process.env.CONTROL_TEMPLATE ?? "agentmatrix-v1",
  python: process.env.CONTROL_PYTHON ??
    (existsSync(join(homedir(), ".venvs/agentsphere/bin/python")) ? join(homedir(), ".venvs/agentsphere/bin/python") : "python3"),
};
const publicOrigin = new URL(process.env.CONTROL_PUBLIC_ORIGIN ?? `http://127.0.0.1:${config.port}`).origin;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/** What the welcome page may see: no secrets, no sandbox address. */
export function botView(bot: BotRecord, now = Date.now()) {
  return {
    status: bot.status,
    stage: bot.stage,
    stages: bot.stages,
    error: bot.error,
    sandbox: bot.sandbox && { state: bot.sandbox.state, endAt: bot.sandbox.endAt },
    keepAwake: bot.keepAwake,
    routines: bot.routines?.length ?? 0,
    nextRoutineAt: nextRoutineFire(bot.routines ?? [], now),
    lastBackupAt: bot.backups.at(-1)?.at,
    backupError: bot.backupError,
    backingUp: isBackingUp(bot.id),
    // Said once next to the button, for ten minutes; failures stay in backupError.
    lastManualBackup: (() => { const last = lastManualBackup.get(bot.id); return last && now - last.at < 10 * 60_000 ? last.outcome : undefined; })(),
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/welcome": { file: join(publicDir, "welcome.html"), type: "text/html; charset=utf-8" },
  "/welcome.js": { file: join(publicDir, "welcome.js"), type: "text/javascript; charset=utf-8" },
  "/welcome.css": { file: join(publicDir, "welcome.css"), type: "text/css; charset=utf-8" },
  "/brand.svg": { file: join(repoRoot, "public/brand/raytone-bot.svg"), type: "image/svg+xml" },
  "/plex.woff2": { file: join(repoRoot, "node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2"), type: "font/woff2" },
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function waitHealthy(origin: string, password: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const health = await botGet(origin, password, "/__agentcanvas/pi/health") as { status?: string } | undefined;
    if (health?.status === "ok") return true;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return false;
}

/** Wakes or extends the sandbox so the user gets a full idle window, then signs a one-time link. */
async function enter(store: Store, platform: Platform, bot: BotRecord): Promise<string> {
  if (bot.status !== "ready" || !bot.sandboxId || !bot.url) throw new HttpError(409, "Bot is not ready");
  const access = readAccess(store, bot.id);
  if (!access.handoffSecret) throw new HttpError(409, "Bot needs one more deploy to accept the welcome page");
  const info = await platform.info(bot.sandboxId);
  if (!info) throw new HttpError(410, "The sandbox no longer exists");
  if (info.state === "paused") await platform.resume(bot.sandboxId, POLICY.idleMs / 1000);
  else if (info.endAt === undefined || info.endAt - Date.now() < POLICY.idleMs) await platform.renew(bot.sandboxId, POLICY.idleMs / 1000);
  if (!await waitHealthy(bot.url, access.password, 45_000)) throw new HttpError(503, "The bot did not come up; try again");
  store.update(bot.id, (record) => {
    record.lastActivityAt = Date.now();
    record.sandbox = { state: "running", checkedAt: Date.now() };
  });
  return `${bot.url}${HANDOFF_PATH}?t=${encodeURIComponent(issueHandoff(access.handoffSecret, bot.url))}`;
}

/** How the last "立即备份" ended, for the page to say why nothing new appeared. */
const lastManualBackup = new Map<string, { outcome: "completed" | "skipped" | "failed"; at: number }>();

/** The welcome page's routes, over an injected store/platform so a test can drive them directly. */
export function serve(store: Store, platform: Platform, provisionContext: ProvisionContext, keeperContext: KeeperContext) {
  const startProvision = (id: string) => {
    void provision(provisionContext, id).then(() => log("provision.done", { bot: id, status: store.get(id)?.status }));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", publicOrigin);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(302, { location: "/welcome" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      const asset = STATIC[url.pathname];
      if (req.method === "GET" && asset) {
        res.writeHead(200, { "content-type": asset.type, "cache-control": url.pathname === "/welcome" ? "no-store" : "max-age=300" });
        return res.end(readFileSync(asset.file));
      }
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");

      const user = currentUser(req);
      if (!user) throw new HttpError(401, "Sign in to Raytone first");
      if (req.method === "POST") {
        // Same-origin JSON only: a form or another site cannot drive these.
        if (req.headers.origin !== publicOrigin) throw new HttpError(403, "Cross-origin request");
        if (!String(req.headers["content-type"]).startsWith("application/json")) throw new HttpError(415, "JSON only");
      }
      const owned = store.ownedBy(user.id);
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /api/bot") return send(res, 200, { user: { id: user.id }, bot: owned ? botView(owned) : null });

      const body = req.method === "POST" ? await readJson(req) : {};
      if (route === "POST /api/bot/claim") {
        // One synchronous check-and-create. Re-reading ownership here (rather than reusing the
        // value read before the body arrived) is what keeps two tabs from claiming two sandboxes.
        const claimed = store.claim(user.id);
        if (!claimed.created) return send(res, 200, { bot: botView(claimed.bot) });
        log("bot.claimed", { bot: claimed.bot.id, owner: user.id });
        startProvision(claimed.bot.id);
        return send(res, 201, { bot: botView(claimed.bot) });
      }
      if (!owned) throw new HttpError(404, "No bot yet");
      switch (route) {
        case "POST /api/bot/retry":
          if (owned.status !== "failed") throw new HttpError(409, "Nothing to retry");
          startProvision(owned.id);
          return send(res, 202, { bot: botView(owned) });
        case "POST /api/bot/enter":
          return send(res, 200, { url: await enter(store, platform, owned) });
        case "POST /api/bot/settings":
          if (typeof body.keepAwake !== "boolean") throw new HttpError(400, "keepAwake must be true or false");
          store.update(owned.id, (record) => { record.keepAwake = body.keepAwake as boolean; });
          return send(res, 200, { bot: botView(store.get(owned.id)!) });
        case "POST /api/bot/backup": {
          if (owned.status !== "ready") throw new HttpError(409, "Bot is not ready");
          // Takes minutes for a large workspace: the page follows `backingUp` instead of waiting here.
          const started = startBackup(keeperContext, owned.id);
          void started?.then((outcome) => { lastManualBackup.set(owned.id, { outcome, at: Date.now() }); });
          return send(res, 202, { bot: botView(store.get(owned.id)!) });
        }
        default:
          throw new HttpError(404, "Not found");
      }
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      log("http.error", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return send(res, 500, { error: "Something went wrong; try again" });
    }
  });
}

/** Adopts an existing deployment (its .agentsphere/ state) as `owner`'s bot; the next deploy adds the handoff secret. */
function importDeployment(store: Store, owner: string, from: string): void {
  if (store.ownedBy(owner)) throw new Error(`${owner} already has a bot`);
  const deployment = JSON.parse(readFileSync(join(from, "deployment.json"), "utf8")) as { sandboxId?: string };
  const access = JSON.parse(readFileSync(join(from, "access.json"), "utf8")) as { password?: string };
  if (!deployment.sandboxId || !access.password) throw new Error(`${from} has no sandbox id or password`);
  const bot = store.create(owner);
  writeAccess(store, bot.id, { password: access.password, handoffSecret: newHandoffSecret(),
    controlOrigin: process.env.CONTROL_PUBLIC_ORIGIN ? publicOrigin : undefined });
  store.update(bot.id, (record) => {
    record.sandboxId = deployment.sandboxId;
    record.url = botOrigin(deployment.sandboxId!);
  });
  console.log(`imported ${deployment.sandboxId} as ${bot.id} for ${owner}; the server redeploys it on start`);
}

function main(): void {
  const store = new Store(config.dataDir);
  const [command] = process.argv.slice(2);
  if (command === "import") {
    const flag = (name: string) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
    const owner = flag("--owner");
    if (!owner) throw new Error("usage: node control/server.ts import --owner ID [--from DIR]");
    importDeployment(store, owner, resolve(flag("--from") ?? join(repoRoot, ".agentsphere")));
    return;
  }
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("set E2B_API_KEY (this machine only; it never enters a sandbox)");
  const loopback = config.host === "127.0.0.1" || config.host === "::1" || config.host === "localhost";
  if (devLoginActive() && !loopback) throw new Error("CONTROL_DEV_USER skips login; it only listens on loopback");
  const platform = agentSphere(apiKey);
  const provisionContext: ProvisionContext = { store, platform, run: runProcess, repoRoot, python: config.python,
    controlOrigin: process.env.CONTROL_PUBLIC_ORIGIN ? publicOrigin : undefined, template: config.template,
    initialTimeoutS: POLICY.idleMs / 1000 };
  const keeperContext: KeeperContext = { store, platform, run: runProcess, repoRoot, python: config.python, log };

  // Provisioning that a restart interrupted, and imports, continue where they were.
  for (const bot of store.list()) {
    if (bot.status === "provisioning") void provision(provisionContext, bot.id).then(() => log("provision.done", { bot: bot.id, status: store.get(bot.id)?.status }));
  }
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await keeperTick(keeperContext); } finally { ticking = false; }
  };
  setInterval(() => void tick(), 60_000);
  void tick();

  serve(store, platform, provisionContext, keeperContext).listen(config.port, config.host, () => {
    log("control.listening", { origin: publicOrigin, dataDir: config.dataDir, devLogin: devLoginActive() });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
