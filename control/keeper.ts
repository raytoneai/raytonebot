import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { cronMatches } from "../src/pi/routines.ts";
import { botGet, type Platform } from "./agentsphere.ts";
import type { RunProcess } from "./provision.ts";
import { readAccess, type BotRecord, type RoutineSnapshot, type Store } from "./store.ts";

/**
 * The keeper (ADR-041): what keeps a bot useful while nobody has it open. Nothing inside a paused
 * sandbox runs and opening its address does not wake it (issue.md #1), so once a minute this
 * decides, per bot, whether to extend the running window, let it pause, back it up before it
 * pauses, or wake it for the next routine. The routine itself still fires from the bot's own
 * clock (ADR-036), which looks back three minutes.
 */

export const POLICY = {
  /** A bot stays up this long after its last entry or observed run. */
  idleMs: 2 * 3600_000,
  /** Renew only when the window is about to end, so each renewal is one call. */
  renewMarginMs: 15 * 60_000,
  /** An idle bot is backed up this close to pausing, when something changed since the last backup. */
  backupMarginMs: 10 * 60_000,
  backupRetryMs: 30 * 60_000,
  /** Bots that never pause are backed up daily instead. */
  backupEveryMs: 24 * 3600_000,
  keepBackups: 7,
  /** Wake this long before a routine fires; resume takes about a second, the app is already running. */
  wakeLeadMs: 90_000,
  routineWakeS: 30 * 60,
  routineRefreshMs: 5 * 60_000,
  /** Within the bot clock's three-minute look-back, a fire that just passed can still run. */
  lookbackMs: 2 * 60_000,
  horizonMs: 48 * 3600_000,
};

export type Observation = { state: "running" | "paused" | "unknown"; endAt?: number;
  /** Undefined when the app does not answer its health check. */
  activeRuns?: number;
  /** Milliseconds since the app last accepted or ended a turn, as the app itself measures it. */
  lastRunAgoMs?: number };

export type Action =
  | { kind: "renew"; seconds: number }
  | { kind: "wake"; seconds: number; fire?: number }
  | { kind: "backup" }
  | { kind: "refreshRoutines" };

/** The first minute at or after `from` (within `horizonMs`) when any routine fires. */
export function nextRoutineFire(routines: readonly RoutineSnapshot[], from: number, horizonMs = POLICY.horizonMs): number | undefined {
  const valid = routines.filter((routine) => {
    try { cronMatches(routine.schedule, routine.timezone, new Date(from)); return true; } catch { return false; }
  });
  if (!valid.length) return undefined;
  const start = Math.ceil(from / 60_000) * 60_000;
  for (let at = start; at <= from + horizonMs; at += 60_000) {
    const date = new Date(at);
    if (valid.some((routine) => cronMatches(routine.schedule, routine.timezone, date))) return at;
  }
  return undefined;
}

/**
 * The last activity the keeper can prove: its own last entry, a turn the app reported, or a run in
 * flight right now. A short turn can begin and end between two ticks, so sampling `activeRuns`
 * alone would report "nothing changed" and the pre-pause backup would be skipped. The app's answer
 * is an age, so a clock difference between host and sandbox cannot invent or hide activity.
 */
export function seenActivity(record: Pick<BotRecord, "lastActivityAt">, seen: Observation, now: number): number {
  const busy = (seen.activeRuns ?? 0) > 0 ? now : 0;
  const reported = seen.lastRunAgoMs === undefined ? 0 : now - Math.max(0, seen.lastRunAgoMs);
  return Math.max(record.lastActivityAt ?? 0, reported, busy);
}

export function decide(bot: BotRecord, seen: Observation, now: number): Action[] {
  if (bot.status !== "ready" || !bot.sandboxId) return [];
  const fire = nextRoutineFire(bot.routines ?? [], now - POLICY.lookbackMs);
  const actions: Action[] = [];
  if (seen.state === "paused") {
    if (bot.keepAwake) return [{ kind: "wake", seconds: POLICY.idleMs / 1000 }];
    if (fire !== undefined && fire - now <= POLICY.wakeLeadMs && bot.wokeFor !== fire) {
      return [{ kind: "wake", seconds: POLICY.routineWakeS, fire }];
    }
    return [];
  }
  if (seen.state !== "running") return [];

  const busy = (seen.activeRuns ?? 0) > 0;
  const lastActivity = busy ? now : bot.lastActivityAt ?? 0;
  const routineSoon = fire !== undefined && fire - now <= POLICY.renewMarginMs + 5 * 60_000;
  const wanted = bot.keepAwake || busy || now - lastActivity < POLICY.idleMs || routineSoon;
  const remaining = seen.endAt === undefined ? 0 : seen.endAt - now;
  if (wanted && remaining < POLICY.renewMarginMs) actions.push({ kind: "renew", seconds: POLICY.idleMs / 1000 });

  const lastBackup = bot.backups.at(-1)?.at ?? 0;
  const retryable = !bot.backupError || now - bot.backupError.at >= POLICY.backupRetryMs;
  const idleNow = seen.activeRuns === 0;
  const pausingSoon = !wanted && remaining < POLICY.backupMarginMs && lastActivity > lastBackup;
  const dailyDue = bot.keepAwake && now - lastBackup >= POLICY.backupEveryMs;
  if (idleNow && retryable && (pausingSoon || dailyDue)) actions.push({ kind: "backup" });

  if (seen.activeRuns !== undefined && now - (bot.routinesCheckedAt ?? 0) >= POLICY.routineRefreshMs) {
    actions.push({ kind: "refreshRoutines" });
  }
  return actions;
}

export type KeeperContext = {
  store: Store;
  platform: Platform;
  run: RunProcess;
  repoRoot: string;
  python: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
};

const backingUp = new Set<string>();

/** One pass over every ready bot; failures are logged per bot and never stop the others. */
export async function keeperTick(context: KeeperContext): Promise<void> {
  const now = context.now ?? Date.now;
  for (const bot of context.store.list()) {
    if (bot.status !== "ready" || !bot.sandboxId) continue;
    try {
      await tickBot(context, bot.id, now);
    } catch (error) {
      context.log("keeper.error", { bot: bot.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function tickBot(context: KeeperContext, id: string, now: () => number): Promise<void> {
  const { store, platform } = context;
  const bot = store.get(id)!;
  const info = await platform.info(bot.sandboxId!);
  const seen: Observation = { state: info?.state ?? "unknown", endAt: info?.endAt };
  const access = readAccess(store, id);
  if (seen.state === "running") {
    const health = await botGet(bot.url!, access.password, "/__agentcanvas/pi/health") as { activeRuns?: unknown; lastRunAgoMs?: unknown } | undefined;
    if (typeof health?.activeRuns === "number") seen.activeRuns = health.activeRuns;
    if (typeof health?.lastRunAgoMs === "number") seen.lastRunAgoMs = health.lastRunAgoMs;
  }
  const at = now();
  store.update(id, (record) => {
    record.sandbox = { state: seen.state, endAt: seen.endAt, activeRuns: seen.activeRuns, checkedAt: at };
    const activity = seenActivity(record, seen, at);
    if (activity > (record.lastActivityAt ?? 0)) record.lastActivityAt = activity;
  });

  for (const action of decide(store.get(id)!, seen, now())) {
    switch (action.kind) {
      case "renew":
        await platform.renew(bot.sandboxId!, action.seconds);
        context.log("keeper.renewed", { bot: id, seconds: action.seconds });
        break;
      case "wake":
        await platform.resume(bot.sandboxId!, action.seconds);
        store.update(id, (record) => {
          if (action.fire !== undefined) record.wokeFor = action.fire;
          record.sandbox = { state: "running", checkedAt: now() };
        });
        context.log("keeper.woke", { bot: id, forRoutineAt: action.fire && new Date(action.fire).toISOString() });
        break;
      case "refreshRoutines": {
        const body = await botGet(bot.url!, access.password, "/__agentcanvas/pi/routines") as { routines?: unknown } | undefined;
        if (!Array.isArray(body?.routines)) break;
        store.update(id, (record) => {
          record.routines = (body.routines as { id: string; schedule: string; timezone: string; enabled: boolean }[])
            .filter((routine) => routine.enabled).map(({ id: routineId, schedule, timezone }) => ({ id: routineId, schedule, timezone }));
          record.routinesCheckedAt = now();
        });
        break;
      }
      case "backup":
        // Can take minutes; ticks keep running meanwhile.
        void startBackup(context, id, now);
        break;
    }
  }
}

export const isBackingUp = (id: string) => backingUp.has(id);

/** One backup per bot at a time; undefined when one is already running. */
export function startBackup(context: KeeperContext, id: string, now: () => number = Date.now) {
  if (backingUp.has(id)) return undefined;
  backingUp.add(id);
  return backupBot(context, id, now).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    context.store.update(id, (record) => { record.backupError = { at: now(), message }; });
    context.log("keeper.backup_failed", { bot: id, message });
    return "failed" as const;
  }).finally(() => backingUp.delete(id));
}

/** Runs sandbox.py's scheduled backup (skips paused or busy hosts and overlaps), then keeps the newest few. */
export async function backupBot(context: KeeperContext, id: string, now: () => number = Date.now): Promise<"completed" | "skipped" | "failed"> {
  const { store } = context;
  const dir = store.botDir(id);
  const result = await context.run(context.python, [join(context.repoRoot, "scripts/agentsphere/sandbox.py"),
    "--state-dir", dir, "backup", "--scheduled"], { cwd: context.repoRoot, env: { ...process.env, E2B_DOMAIN: "agentsphere.run" } });
  let event: { event?: string; archive?: string; reason?: string } = {};
  for (const line of [...result.tail].reverse()) {
    try { event = JSON.parse(line); break; } catch { /* not the event line */ }
  }
  if (result.code === 0 && event.event === "backup_completed" && event.archive) {
    const file = join(dir, "backups", event.archive);
    store.update(id, (record) => {
      record.backups.push({ file: event.archive!, at: now(), bytes: statSync(file).size });
      delete record.backupError;
      const drop = record.backups.splice(0, Math.max(0, record.backups.length - POLICY.keepBackups));
      for (const old of drop) { try { unlinkSync(join(dir, "backups", old.file)); } catch { /* already gone */ } }
    });
    context.log("keeper.backed_up", { bot: id, archive: event.archive });
    return "completed";
  }
  if (result.code === 0 && event.event === "backup_skipped") {
    context.log("keeper.backup_skipped", { bot: id, reason: event.reason });
    return "skipped";
  }
  const message = event.reason ?? result.tail.find((line) => line.startsWith("FAIL:"))?.slice(5).trim() ?? `exit ${result.code}`;
  store.update(id, (record) => { record.backupError = { at: now(), message }; });
  context.log("keeper.backup_failed", { bot: id, message });
  return "failed";
}
