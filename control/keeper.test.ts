import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Platform } from "./agentsphere.ts";
import { backupBot, decide, nextRoutineFire, POLICY, seenActivity, type KeeperContext } from "./keeper.ts";
import type { RunProcess } from "./provision.ts";
import { Store, type BotRecord } from "./store.ts";

const T0 = Date.parse("2026-10-14T08:00:00Z");
const MIN = 60_000;

const ready = (patch: Partial<BotRecord> = {}): BotRecord => ({
  id: "b1", owner: "u", createdAt: 0, status: "ready", stages: {}, sandboxId: "sbx", url: "https://5188-sbx.agentsphere.run",
  keepAwake: false, backups: [], routinesCheckedAt: T0, ...patch,
});
const kinds = (bot: BotRecord, seen: Parameters<typeof decide>[1], now = T0) => decide(bot, seen, now).map((action) => action.kind);

test("next routine fire follows each routine's timezone", () => {
  const routines = [{ id: "r", schedule: "0 9 * * *", timezone: "Asia/Shanghai" }];
  assert.equal(nextRoutineFire(routines, Date.parse("2026-10-14T00:30:00Z")), Date.parse("2026-10-14T01:00:00Z"));
  assert.equal(nextRoutineFire(routines, Date.parse("2026-10-14T01:00:00Z")), Date.parse("2026-10-14T01:00:00Z"), "the current minute counts");
  assert.equal(nextRoutineFire(routines, Date.parse("2026-10-14T01:00:30Z")), Date.parse("2026-10-15T01:00:00Z"));
  const weekly = [{ id: "w", schedule: "0 9 * * 1", timezone: "Asia/Shanghai" }];
  assert.equal(nextRoutineFire(weekly, T0), undefined, "beyond the 48-hour horizon");
  assert.equal(nextRoutineFire([{ id: "x", schedule: "0 9 * * *", timezone: "Not/AZone" }], T0), undefined, "an invalid timezone is skipped");
  assert.equal(nextRoutineFire([], T0), undefined);
});

test("a running bot is renewed only while wanted and only near its end", () => {
  const near = { state: "running" as const, endAt: T0 + 10 * MIN, activeRuns: 0 };
  assert.deepEqual(decide(ready({ lastActivityAt: T0 - 30 * MIN }), near, T0), [{ kind: "renew", seconds: POLICY.idleMs / 1000 }]);
  assert.deepEqual(kinds(ready({ lastActivityAt: T0 - 30 * MIN }), { ...near, endAt: T0 + 60 * MIN }), [], "not yet near the end");
  assert.deepEqual(kinds(ready({ lastActivityAt: T0 - 3 * 3600_000 }), { ...near, endAt: T0 + 30 * MIN }), [], "idle: let it pause");
  assert.deepEqual(kinds(ready({ lastActivityAt: 0 }), { ...near, activeRuns: 1 }), ["renew"], "a run keeps it up");
  assert.deepEqual(kinds(ready({ keepAwake: true, backups: [{ file: "a", at: T0, bytes: 1 }] }), near), ["renew"]);
  assert.deepEqual(kinds(ready({ lastActivityAt: T0 - 30 * MIN }), { ...near, endAt: undefined }), ["renew"], "unknown end counts as near");
});

test("a routine just after the window ends keeps the bot up instead of pausing and waking", () => {
  const bot = ready({ lastActivityAt: 0, backups: [{ file: "a", at: T0, bytes: 1 }],
    routines: [{ id: "r", schedule: "15 8 * * *", timezone: "UTC" }] });
  assert.deepEqual(kinds(bot, { state: "running", endAt: T0 + 10 * MIN, activeRuns: 0 }), ["renew"]);
});

test("an idle bot is backed up once before it pauses", () => {
  const seen = { state: "running" as const, endAt: T0 + 5 * MIN, activeRuns: 0 };
  const idle = ready({ lastActivityAt: T0 - 3 * 3600_000 });
  assert.deepEqual(kinds(idle, seen), ["backup"]);
  assert.deepEqual(kinds({ ...idle, backups: [{ file: "a", at: T0 - 3600_000, bytes: 1 }] }, seen), [], "nothing changed since");
  assert.deepEqual(kinds(idle, { ...seen, activeRuns: undefined }), [], "app not answering");
  assert.deepEqual(kinds({ ...idle, backupError: { at: T0 - 5 * MIN, message: "x" } }, seen), [], "recent failure waits");
  assert.deepEqual(kinds({ ...idle, backupError: { at: T0 - 31 * MIN, message: "x" } }, seen), ["backup"]);
  assert.deepEqual(kinds(idle, { ...seen, endAt: T0 + 20 * MIN }), [], "not close to pausing yet");
});

test("a bot kept awake is backed up daily", () => {
  const seen = { state: "running" as const, endAt: T0 + 90 * MIN, activeRuns: 0 };
  assert.deepEqual(kinds(ready({ keepAwake: true, backups: [{ file: "a", at: T0 - 25 * 3600_000, bytes: 1 }] }), seen), ["backup"]);
  assert.deepEqual(kinds(ready({ keepAwake: true, backups: [{ file: "a", at: T0 - 3600_000, bytes: 1 }] }), seen), []);
  assert.deepEqual(kinds(ready({ keepAwake: true, backups: [] }), { ...seen, activeRuns: 2 }), [], "never during a run");
});

test("a paused bot wakes shortly before its next routine, once per fire", () => {
  const routines = [{ id: "r", schedule: "0 8 * * *", timezone: "UTC" }];
  const fire = T0;
  assert.deepEqual(decide(ready({ routines }), { state: "paused" }, fire - 80_000), [{ kind: "wake", seconds: POLICY.routineWakeS, fire }]);
  assert.deepEqual(kinds(ready({ routines }), { state: "paused" }, fire - 5 * MIN), [], "too early");
  assert.deepEqual(kinds(ready({ routines, wokeFor: fire }), { state: "paused" }, fire - 30_000), [], "already woken for it");
  assert.deepEqual(kinds(ready({ routines }), { state: "paused" }, fire + 60_000), ["wake"], "still inside the bot clock's look-back");
  assert.deepEqual(kinds(ready({ routines }), { state: "paused" }, fire + 5 * MIN), [], "long past: skipped, as the bot would");
  assert.deepEqual(kinds(ready({ keepAwake: true }), { state: "paused" }), ["wake"]);
  assert.deepEqual(kinds(ready({ status: "provisioning" }), { state: "paused" }), []);
  assert.deepEqual(kinds(ready(), { state: "unknown" }), []);
});

test("routines are refreshed every few minutes while the app answers", () => {
  const seen = { state: "running" as const, endAt: T0 + 90 * MIN, activeRuns: 0 };
  assert.deepEqual(kinds(ready({ lastActivityAt: T0, routinesCheckedAt: T0 - 6 * MIN }), seen), ["refreshRoutines"]);
  assert.deepEqual(kinds(ready({ lastActivityAt: T0, routinesCheckedAt: T0 - 6 * MIN }), { ...seen, activeRuns: undefined }), []);
});

test("a turn that ran between two ticks still makes the pre-pause backup happen", () => {
  const lastBackup = T0 - 3 * 3600_000;
  const seen = { state: "running" as const, endAt: T0 + 5 * MIN, activeRuns: 0 };
  const bot = ready({ lastActivityAt: T0 - 4 * 3600_000, backups: [{ file: "a", at: lastBackup, bytes: 1 }] });
  // The keeper's own sampling never saw the turn, so on that evidence nothing changed.
  assert.deepEqual(kinds(bot, seen), [], "sampled state alone skips the backup");
  // The app reports a turn 2.5 hours ago: newer than the backup, so the pause is preceded by one.
  const activity = seenActivity(bot, { ...seen, lastRunAgoMs: 2.5 * 3600_000 }, T0);
  assert.equal(activity, T0 - 2.5 * 3600_000);
  assert.deepEqual(kinds({ ...bot, lastActivityAt: activity }, seen), ["backup"]);
  // A run in flight counts as now; a nonsense age counts as just now, never as no activity.
  assert.equal(seenActivity(bot, { state: "running", activeRuns: 1 }, T0), T0);
  assert.equal(seenActivity(bot, { ...seen, lastRunAgoMs: -1000 }, T0), T0);
  assert.equal(seenActivity(bot, { state: "paused" }, T0), T0 - 4 * 3600_000, "an app that cannot answer changes nothing");
});

test("backups record the archive, keep the newest few and surface failures", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "control-")));
  const bot = store.create("u");
  mkdirSync(join(store.botDir(bot.id), "backups"));
  let next: { code: number; tail: string[] } = { code: 0, tail: [] };
  const calls: string[][] = [];
  const run: RunProcess = async (_command, args) => { calls.push(args); return next; };
  const context: KeeperContext = { store, platform: {} as Platform, run, repoRoot: "/repo", python: "py", log: () => {} };
  for (let index = 0; index < POLICY.keepBackups + 2; index += 1) {
    const archive = `sbx-${index}.tgz`;
    writeFileSync(join(store.botDir(bot.id), "backups", archive), "x".repeat(index + 1));
    next = { code: 0, tail: ["noise", JSON.stringify({ event: "backup_completed", archive })] };
    assert.equal(await backupBot(context, bot.id, () => T0 + index), "completed");
  }
  assert.deepEqual(calls[0], ["/repo/scripts/agentsphere/sandbox.py", "--state-dir", store.botDir(bot.id), "backup", "--scheduled"]);
  const kept = store.get(bot.id)!.backups;
  assert.equal(kept.length, POLICY.keepBackups);
  assert.equal(kept.at(-1)!.bytes, POLICY.keepBackups + 2);
  assert.equal(existsSync(join(store.botDir(bot.id), "backups", "sbx-0.tgz")), false, "oldest removed");
  assert.equal(existsSync(join(store.botDir(bot.id), "backups", "sbx-2.tgz")), true);

  next = { code: 0, tail: [JSON.stringify({ event: "backup_skipped", reason: "sandbox paused" })] };
  assert.equal(await backupBot(context, bot.id), "skipped");
  assert.equal(store.get(bot.id)!.backupError, undefined);
  next = { code: 1, tail: ["FAIL: remote command failed (1): sudo"] };
  assert.equal(await backupBot(context, bot.id, () => T0), "failed");
  assert.deepEqual(store.get(bot.id)!.backupError, { at: T0, message: "remote command failed (1): sudo" });
});
