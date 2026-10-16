import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The control service's records (ADR-041): who owns which bot, where its sandbox is and how far
 * provisioning got. No secrets here — each bot's password and handoff secret live in its own
 * state directory (`bots/<id>/access.json`), the one deploy.py and sandbox.py already read.
 */

export const STAGES = ["sandbox", "build", "upload", "deps", "browser", "configure", "start", "verify"] as const;
export type Stage = (typeof STAGES)[number];

export type RoutineSnapshot = { id: string; schedule: string; timezone: string };

export type BotRecord = {
  id: string;
  owner: string;
  createdAt: number;
  status: "provisioning" | "ready" | "failed";
  /** The stage running now, or the one that failed. */
  stage?: Stage;
  stages: Partial<Record<Stage, { startedAt: number; endedAt?: number }>>;
  error?: { stage: Stage; message: string };
  sandboxId?: string;
  url?: string;
  keepAwake: boolean;
  /** Last entry from the welcome page or last observed run; drives the idle window. */
  lastActivityAt?: number;
  /** As last seen by the keeper. */
  sandbox?: { state: "running" | "paused" | "unknown"; endAt?: number; activeRuns?: number; checkedAt: number };
  routines?: RoutineSnapshot[];
  routinesCheckedAt?: number;
  /** The routine minute the keeper already woke the sandbox for, so one fire wakes it once. */
  wokeFor?: number;
  backups: { file: string; at: number; bytes: number }[];
  backupError?: { at: number; message: string };
};

type StoreFile = { version: 1; bots: BotRecord[] };

export class Store {
  readonly dir: string;
  private readonly file: string;
  private data: StoreFile;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "bots"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.file = join(dir, "store.json");
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = { version: 1, bots: [] };
    }
  }

  botDir(id: string): string {
    return join(this.dir, "bots", id);
  }

  list(): readonly BotRecord[] {
    return this.data.bots;
  }

  get(id: string): BotRecord | undefined {
    return this.data.bots.find((bot) => bot.id === id);
  }

  ownedBy(owner: string): BotRecord | undefined {
    return this.data.bots.find((bot) => bot.owner === owner);
  }

  create(owner: string, now = Date.now()): BotRecord {
    const bot: BotRecord = { id: `b${randomUUID().replace(/-/g, "").slice(0, 10)}`, owner, createdAt: now,
      status: "provisioning", stages: {}, keepAwake: false, backups: [] };
    mkdirSync(this.botDir(bot.id), { recursive: true, mode: 0o700 });
    this.data.bots.push(bot);
    this.save();
    return bot;
  }

  /**
   * The owner's bot, created if they have none. Checking and creating happen in one synchronous
   * call: a request that awaits anything in between would let two tabs each create a sandbox and
   * leave one of them with no record the welcome page can reach.
   */
  claim(owner: string, now = Date.now()): { bot: BotRecord; created: boolean } {
    const existing = this.ownedBy(owner);
    if (existing) return { bot: existing, created: false };
    return { bot: this.create(owner, now), created: true };
  }

  /** Applies `change` to the bot and writes the whole file through a temp file. */
  update(id: string, change: (bot: BotRecord) => void): BotRecord {
    const bot = this.get(id);
    if (!bot) throw new Error(`no bot ${id}`);
    change(bot);
    this.save();
    return bot;
  }

  private save(): void {
    const temp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

export type BotAccess = { password: string; handoffSecret?: string; controlOrigin?: string };

export function readAccess(store: Store, id: string): BotAccess {
  return JSON.parse(readFileSync(join(store.botDir(id), "access.json"), "utf8")) as BotAccess;
}

export function writeAccess(store: Store, id: string, access: BotAccess): void {
  const file = join(store.botDir(id), "access.json");
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(access, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
