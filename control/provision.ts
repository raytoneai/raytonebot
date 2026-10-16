import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { newHandoffSecret } from "../scripts/handoff.mjs";
import { botOrigin, type Platform } from "./agentsphere.ts";
import { readAccess, STAGES, writeAccess, type Stage, type Store } from "./store.ts";

/**
 * Claiming a bot (ADR-041): create its sandbox, build once per commit, then run the existing
 * deploy.py against the bot's own state directory and turn its output into progress stages.
 * Re-running is safe: an existing sandbox is reused and deploy.py is idempotent, so a retry or a
 * control restart simply continues.
 */

export type ProcessResult = { code: number; tail: string[] };
export type RunProcess = (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv },
  onLine?: (line: string) => void) => Promise<ProcessResult>;

export type ProvisionContext = {
  store: Store;
  platform: Platform;
  run: RunProcess;
  repoRoot: string;
  python: string;
  controlOrigin?: string;
  template: string;
  /** The first window before the keeper's idle policy takes over. */
  initialTimeoutS: number;
  now?: () => number;
};

/** Where a deploy.py output line moves the progress bar; lines are printed as each step begins or ends. */
export function deployStage(line: string): Stage | undefined {
  const prefix = /^([a-z]+):/.exec(line)?.[1];
  switch (prefix) {
    case "upload": return "upload";
    case "deps": return "deps";
    case "browser": return "browser";
    case "isolation": return "configure";
    case "env": return "start";
    case "start": return "verify";
    default: return undefined;
  }
}

export const runProcess: RunProcess = (command, args, options, onLine) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  const tail: string[] = [];
  const feed = (stream: NodeJS.ReadableStream) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line);
      }
    });
  };
  feed(child.stdout!);
  feed(child.stderr!);
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, tail }));
});

let builtHead: string | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Deploys share one build output and one machine, so they run one at a time. */
export function provision(context: ProvisionContext, botId: string): Promise<void> {
  const next = queue.then(() => provisionNow(context, botId));
  queue = next.catch(() => undefined);
  return next;
}

async function provisionNow(context: ProvisionContext, botId: string): Promise<void> {
  const { store, platform } = context;
  const now = context.now ?? Date.now;
  const enter = (stage: Stage) => store.update(botId, (bot) => {
    if (bot.stage && bot.stage !== stage) bot.stages[bot.stage] = { ...bot.stages[bot.stage]!, endedAt: now() };
    bot.stage = stage;
    bot.stages[stage] = { startedAt: now() };
  });
  store.update(botId, (bot) => { bot.status = "provisioning"; delete bot.error; delete bot.stage; bot.stages = {}; });
  let stage: Stage = "sandbox";
  try {
    enter(stage);
    const bot = store.get(botId)!;
    const existing = bot.sandboxId ? await platform.info(bot.sandboxId) : undefined;
    const sandboxId = existing ? bot.sandboxId! : await platform.create(context.template, context.initialTimeoutS);
    if (existing?.state === "paused") await platform.resume(sandboxId, context.initialTimeoutS);
    const origin = botOrigin(sandboxId);
    let access;
    try { access = readAccess(store, botId); } catch { access = undefined; }
    writeAccess(store, botId, {
      password: access?.password ?? randomBytes(24).toString("base64url"),
      handoffSecret: access?.handoffSecret ?? newHandoffSecret(),
      controlOrigin: context.controlOrigin,
    });
    store.update(botId, (record) => { record.sandboxId = sandboxId; record.url = origin; });

    stage = "build";
    enter(stage);
    await build(context);

    stage = "upload";
    enter(stage);
    const result = await context.run(context.python, [join(context.repoRoot, "scripts/agentsphere/deploy.py"),
      "--sandbox", sandboxId, "--state-dir", store.botDir(botId), "--skip-build"],
    { cwd: context.repoRoot, env: { ...process.env, E2B_DOMAIN: "agentsphere.run" } }, (line) => {
      const next = deployStage(line);
      if (next && STAGES.indexOf(next) > STAGES.indexOf(stage)) { stage = next; enter(stage); }
    });
    if (result.code !== 0) throw new Error(failureLine(result.tail) ?? `deploy exited with ${result.code}`);
    store.update(botId, (record) => {
      record.stages[stage] = { ...record.stages[stage]!, endedAt: now() };
      record.status = "ready";
      delete record.stage;
      record.lastActivityAt = now();
    });
  } catch (error) {
    store.update(botId, (record) => {
      record.status = "failed";
      record.stage = stage;
      record.error = { stage, message: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
    });
  }
}

/** deploy.py and sandbox.py report a failure on a line starting with "FAIL:"; nothing secret is printed. */
export function failureLine(tail: string[]): string | undefined {
  const line = [...tail].reverse().find((entry) => entry.startsWith("FAIL:"));
  return line?.slice(5).trim();
}

async function build(context: ProvisionContext): Promise<void> {
  const head = await context.run("git", ["rev-parse", "HEAD"], { cwd: context.repoRoot });
  const dirty = await context.run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: context.repoRoot });
  const commit = head.code === 0 ? head.tail.at(-1) : undefined;
  // A clean tree that was already built is reused; local edits always rebuild.
  if (commit && dirty.code === 0 && dirty.tail.every((line) => !line.trim()) && builtHead === commit &&
      existsSync(join(context.repoRoot, "dist", "index.html"))) return;
  const result = await context.run("npm", ["run", "build"], { cwd: context.repoRoot });
  if (result.code !== 0) throw new Error(`build failed: ${result.tail.slice(-3).join(" ").slice(0, 300)}`);
  builtHead = commit;
}
