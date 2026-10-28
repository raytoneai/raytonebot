import type { BotConfigStore } from "./botConfig.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AppLocale } from "../i18n/locales.ts";
import type { ChannelModel } from "./imChannels/types.ts";
import type { PiPermissionMode, PiRuntimeController } from "./piHost.ts";
import { ROUTINE_FAILURE_LIMIT, ROUTINE_HISTORY_LIMIT, type RoutineRun, type RoutineRunStatus, type RoutineView } from "./routineTypes.ts";
import { cronMatches, cronProblem, nextCronOccurrence, timezoneProblem } from "../runtime/routineSchedule.ts";
import { readSettingsFile } from "./settingsFile.ts";

export { cronMatches, cronProblem } from "../runtime/routineSchedule.ts";

/**
 * Routines (ADR-033): saved instructions the creating Bot runs on a schedule. The host keeps the definitions
 * and a run entry that is safe to call twice; the host's own clock (ADR-036) calls it on each
 * matching minute while the sandbox is awake. Each routine runs in its own ordinary conversation,
 * as that same Bot, with the host's default permission mode and the server's environment key, like an IM chat.
 */

export type Routine = Omit<RoutineView, "model" | "nextRunAt"> & {
  /** The model service of the turn that created it; definitions hold no secrets. */
  model?: ChannelModel;
  locale?: AppLocale;
  /** Occurrences already accepted, newest last. Kept with the routine, so deleting or resetting
   *  its conversation cannot make an old occurrence run again. */
  occurrences?: string[];
};

export type RoutineRequest = { title: string; schedule: string; timezone: string; instructions: string };
export type RoutineCreateInput = RoutineRequest & { fromConversationId: string; botId?: string; model?: ChannelModel; locale?: AppLocale };

export class RoutineError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const validRun = (run: RoutineRun) => run && typeof run.occurrenceId === "string" && Number.isFinite(run.at)
  && ["running", "success", "error", "cancelled", "interrupted"].includes(run.status)
  && (run.error === undefined || typeof run.error === "string") && (run.runId === undefined || typeof run.runId === "string")
  && (run.textId === undefined || typeof run.textId === "string") && (run.finishedAt === undefined || Number.isFinite(run.finishedAt));
const withRun = (routine: Routine, run: RoutineRun): Routine => ({ ...routine, lastRun: run,
  history: [run, ...(routine.history ?? (routine.lastRun ? [routine.lastRun] : [])).filter(item => item.occurrenceId !== run.occurrenceId)].slice(0, ROUTINE_HISTORY_LIMIT) });

function definition(input: { title?: unknown; instructions?: unknown; schedule?: unknown; timezone?: unknown }): RoutineRequest {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  const schedule = typeof input.schedule === "string" ? input.schedule.trim().split(/\s+/).join(" ") : "";
  const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
  if (!title || title.length > 80) throw new RoutineError("A title of 1-80 characters is required.", 400);
  if (!instructions || instructions.length > 4000) throw new RoutineError("Instructions of 1-4000 characters are required.", 400);
  const problem = (schedule ? cronProblem(schedule) : "A schedule is required.") ?? (timezone ? timezoneProblem(timezone) : "A timezone is required.");
  if (problem) throw new RoutineError(problem, 400);
  return { title, instructions, schedule, timezone };
}

/** `routines.json` in the bot's data directory, written whole through a temp file. */
export class RoutineStore {
  private routines: Routine[] = [];
  private readonly file?: string;
  readonly error?: Error;

  constructor(file?: string) {
    this.file = file;
    const loaded = readSettingsFile<{ routines: Routine[] }>(file, data => Array.isArray(data.routines) && data.routines.every(routine =>
      routine && (routine.botId === undefined || typeof routine.botId === "string") && typeof routine.id === "string" && typeof routine.title === "string" && typeof routine.instructions === "string"
      && typeof routine.schedule === "string" && !cronProblem(routine.schedule)
      && typeof routine.timezone === "string" && !timezoneProblem(routine.timezone)
      && typeof routine.enabled === "boolean" && Number.isFinite(routine.createdAt) && Number.isFinite(routine.failures)
      && typeof routine.conversationId === "string" && (routine.occurrences === undefined || Array.isArray(routine.occurrences) && routine.occurrences.every(id => typeof id === "string"))
      && (routine.revision === undefined || Number.isSafeInteger(routine.revision) && routine.revision >= 0)
      && (routine.lastRun === undefined || validRun(routine.lastRun))
      && (routine.history === undefined || Array.isArray(routine.history) && routine.history.every(validRun))));
    this.error = loaded.error;
    if (loaded.data) {
      this.routines = loaded.data.routines
        // A run in flight when the host stopped is not resumed or replayed.
        .map((routine) => {
          const interrupted = (run: RoutineRun): RoutineRun => run.status === "running" ? { ...run, status: "interrupted", waiting: undefined } : run;
          return { ...routine, revision: routine.revision ?? 0,
            ...(routine.lastRun ? { lastRun: interrupted(routine.lastRun) } : {}),
            history: (routine.history ?? (routine.lastRun ? [routine.lastRun] : [])).slice(0, ROUTINE_HISTORY_LIMIT).map(interrupted) };
        });
    }
  }

  list() { if (this.error) throw this.error; return this.routines.map((routine) => structuredClone(routine)); }
  get(id: string) { if (this.error) throw this.error; const routine = this.routines.find((item) => item.id === id); return routine && structuredClone(routine); }

  put(routine: Routine) {
    if (this.error) throw this.error;
    const next = [...this.routines.filter((item) => item.id !== routine.id), routine].sort((a, b) => a.createdAt - b.createdAt);
    this.save(next);
    this.routines = next;
  }

  remove(id: string) {
    if (this.error) throw this.error;
    const next = this.routines.filter((item) => item.id !== id);
    if (next.length === this.routines.length) return false;
    this.save(next);
    this.routines = next;
    return true;
  }

  private save(routines: Routine[]) {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ routines }, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export function routineView({ model, locale: _locale, occurrences: _occurrences, ...routine }: Routine): RoutineView {
  return { ...routine, revision: routine.revision ?? 0, ...(model ? { model: { provider: model.definition.id, model: model.model } } : {}) };
}

export function routinePrompt(routine: Routine, occurrenceId: string, now: Date): string {
  return [
    `[Routine "${routine.title}" · run ${occurrenceId} · ${now.toISOString()} · schedule ${routine.schedule} ${routine.timezone}]`,
    "This is an unattended scheduled run; the user is not watching now. Fetch fresh data every time and do not rely on earlier runs. If nothing is worth reporting, say so in one line.",
    `Task:\n${routine.instructions}`,
  ].join("\n\n");
}

const OCCURRENCE = /^[A-Za-z0-9._-]{1,80}$/;
/** Accepted occurrences remembered per routine; replaying older ones is out of contract. */
const OCCURRENCE_MEMORY = 500;
/** Refusals that are not the routine's fault: they never count towards switching it off. */
const BUSY = /already|in progress|Stop this conversation/i;
const MINUTE = 60_000;
/** Checked twice a minute, so a step is never more than half a minute late. */
const CLOCK_INTERVAL = 30_000;
/** Minutes a late step still covers; anything older counts as slept through. */
const CLOCK_LOOKBACK = 3;

export function createRoutineService(options: {
  dataDir?: string;
  bots?: BotConfigStore;
  runtime: Pick<PiRuntimeController, "runPrompt" | "configure" | "getConversation"> & Partial<Pick<PiRuntimeController, "awaitingUser">>;
  permissionMode: PiPermissionMode;
  log?(event: string, fields: Record<string, unknown>): void;
  now?(): Date;
}) {
  const store = new RoutineStore(options.dataDir ? join(options.dataDir, "routines.json") : undefined);
  const now = options.now ?? (() => new Date());
  /** Includes accepted runs, even if recording their current state fails. */
  const starting = new Set<string>();
  const nextRuns = new Map<string, { schedule: string; timezone: string; checkedAt: number; at?: number }>();
  const viewOf = (routine: Routine): RoutineView => {
    const view = routineView(routine);
    if (routine.enabled) {
      const at = now().getTime(), cached = nextRuns.get(routine.id);
      if (!cached || cached.schedule !== routine.schedule || cached.timezone !== routine.timezone || at < cached.checkedAt
        || (cached.at === undefined ? at - cached.checkedAt >= 86_400_000 : cached.at <= at)) {
        nextRuns.set(routine.id, { schedule: routine.schedule, timezone: routine.timezone, checkedAt: at,
          at: nextCronOccurrence(routine.schedule, routine.timezone, at) });
      }
      const nextRunAt = nextRuns.get(routine.id)?.at;
      if (nextRunAt !== undefined) view.nextRunAt = nextRunAt;
    }
    if (view.lastRun?.status === "running" && options.runtime.awaitingUser?.(routine.conversationId)) {
      view.lastRun = { ...view.lastRun, waiting: true };
      view.history = view.history?.map(run => run.occurrenceId === view.lastRun!.occurrenceId ? { ...run, waiting: true } : run);
    }
    return view;
  };

  const required = (id: string) => {
    const routine = store.get(id);
    if (!routine) throw new RoutineError("Routine not found.", 404);
    return routine;
  };

  /** Bookkeeping after acceptance runs in the background: a failed disk is logged, never thrown,
   *  so it cannot become an unhandled rejection that ends the host. */
  const record = (routine: Routine) => {
    try { store.put(routine); return true; } catch (failure) {
      options.log?.("routine.save_failed", { routineId: routine.id, error: failure instanceof Error ? failure.message : String(failure) });
      return false;
    }
  };

  const finish = (id: string, occurrenceId: string, status: RoutineRunStatus, error?: string) => {
    const routine = store.get(id);
    if (!routine || routine.lastRun?.occurrenceId !== occurrenceId) return; // Deleted, or a newer run.
    const failures = status === "error" ? routine.failures + 1 : status === "success" ? 0 : routine.failures;
    // "Auth fails twice means pause that clock and tell me": repeated failures switch it off.
    const stop = status === "error" && failures >= ROUTINE_FAILURE_LIMIT && routine.enabled;
    if (!record({ ...withRun(routine, { ...routine.lastRun, status, finishedAt: now().getTime(), ...(error ? { error } : {}) }), failures,
      ...(stop ? { enabled: false, disabledReason: error ?? "Failed twice in a row." } : {}) })) return;
    options.log?.("routine.finished", { routineId: id, status, ...(stop ? { disabled: true } : {}) });
  };

  /** A run that failed before it started (configuration, storage) still counts as a failure. */
  const failedToStart = (id: string, occurrenceId: string, error: string) => {
    const routine = store.get(id);
    if (!routine) return;
    if (record(withRun(routine, { occurrenceId, at: now().getTime(), status: "running" }))) finish(id, occurrenceId, "error", error);
  };

  const service = {
    list: () => store.list().map(viewOf),

    create(input: RoutineCreateInput): RoutineView {
      const { title, instructions, schedule, timezone } = definition(input);
      if (input.fromConversationId.startsWith("routine-")) throw new RoutineError("A routine run cannot create routines.", 400);
      // Never fall back to another model: a routine runs only on the service it was made with.
      if (!input.model) throw new RoutineError("This conversation has no configured model service. Choose one in Settings → Model services, then ask again.", 400);
      const botId = input.botId ?? "assistant";
      options.bots?.require(botId);
      const id = randomUUID().slice(0, 8);
      // Created switched off: "clocks stay Disabled until I hit Enable".
      const routine: Routine = { id, botId, title, schedule, timezone, instructions, enabled: false,
        createdAt: now().getTime(), revision: 1, history: [], conversationId: `routine-${id}`, failures: 0,
        model: input.model, ...(input.locale ? { locale: input.locale } : {}) };
      store.put(routine);
      options.log?.("routine.created", { routineId: id });
      return viewOf(routine);
    },

    update(id: string, patch: { enabled?: unknown; revision?: unknown; title?: unknown; instructions?: unknown; schedule?: unknown; timezone?: unknown }): RoutineView {
      const routine = required(id);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RoutineError("A routine update is required.", 400);
      const editing = ["title", "instructions", "schedule", "timezone"].some(key => key in patch);
      if (editing && (starting.has(id) || routine.lastRun?.status === "running")) throw new RoutineError("Stop this conversation before editing its routine.", 409);
      if ((editing || patch.revision !== undefined) && patch.revision !== (routine.revision ?? 0)) throw new RoutineError("This routine changed. Reopen its editor before saving.", 409);
      if ((!editing && typeof patch.enabled !== "boolean") || (patch.enabled !== undefined && typeof patch.enabled !== "boolean")) throw new RoutineError("enabled must be true or false.", 400);
      let next: Routine = patch.enabled === true
        ? { ...routine, enabled: true, failures: 0, disabledReason: undefined }
        : patch.enabled === false ? { ...routine, enabled: false } : routine;
      if (editing) next = { ...next, ...definition(patch), revision: (routine.revision ?? 0) + 1 };
      store.put(next);
      return viewOf(next);
    },

    remove(id: string) {
      if (!store.remove(id)) throw new RoutineError("Routine not found.", 404);
      nextRuns.delete(id);
    },

    /**
     * The clock's and Run now's entry: resolves once the run is accepted and keeps it going in the
     * background. The same occurrence never runs twice, across restarts too: the routine keeps
     * the occurrences it accepted, and the request id is also checked against the conversation's
     * saved turns. Busy or full is a refusal, never a queue, and never counts as a failure.
     */
    async run(id: string, occurrenceId: unknown): Promise<{ runId: string; conversationId: string }> {
      if (typeof occurrenceId !== "string" || !OCCURRENCE.test(occurrenceId)) {
        throw new RoutineError("occurrenceId must be 1-80 letters, digits, dots, dashes or underscores.", 400);
      }
      const routine = required(id);
      if (!routine.enabled) throw new RoutineError("This routine is switched off.", 409);
      const model = routine.model;
      if (!model) throw new RoutineError("This routine has no model service. Delete it and create it again after choosing one.", 409);
      const runId = `routine_${id}_${occurrenceId}`;
      if (routine.occurrences?.includes(occurrenceId)
        || options.runtime.getConversation(routine.conversationId)?.turns?.some((turn) => turn.runId === runId)) {
        throw new RoutineError("This occurrence has already run.", 409);
      }
      if (starting.has(id)) throw new RoutineError("This routine is already running.", 409);
      starting.add(id);
      let accepted = false;
      try {
        const botId = routine.botId ?? "assistant";
        const bot = options.bots?.require(botId);
        await options.runtime.configure({ conversationId: routine.conversationId, credentialSource: "host", providerDefinition: model.definition,
          provider: model.definition.id, model: model.model });
        let status: RoutineRunStatus = "error", error: string | undefined;
        await new Promise<void>((resolve, reject) => {
          const onEvent = (event: AgentUXEvent) => {
            if (!accepted) {
              accepted = true;
              const current = store.get(id);
              // On a failed disk the conversation's saved turn still guards this occurrence; the run goes on.
              if (current) record({ ...withRun(current, { occurrenceId, runId, at: now().getTime(), status: "running" }),
                occurrences: [...(current.occurrences ?? []), occurrenceId].slice(-OCCURRENCE_MEMORY) });
              resolve();
            }
            if (event.type === "text.started" && event.payload.role === "user") {
              const current = store.get(id);
              if (current?.lastRun?.occurrenceId === occurrenceId && !current.lastRun.textId) {
                record(withRun(current, { ...current.lastRun, textId: event.payload.textId }));
              }
            }
            if (event.type === "run.finished") status = String((event.payload as { status?: unknown }).status ?? "success") as RoutineRunStatus;
            if (event.type === "run.error") {
              status = "error";
              error = String((event.payload as { message?: unknown }).message ?? "").trim() || undefined;
            }
          };
          options.runtime.runPrompt({ conversationId: routine.conversationId, requestId: runId, botId, agentPreset: bot?.presetId ?? "assistant",
            prompt: routinePrompt(routine, occurrenceId, now()), permissionMode: options.permissionMode,
            provider: model.definition.id, model: model.model,
            ...(routine.locale ? { locale: routine.locale } : {}) }, onEvent, { title: routine.title }).then(
            () => { starting.delete(id); if (accepted) finish(id, occurrenceId, status, error); else reject(new Error("The run ended before it started.")); },
            (failure: unknown) => {
              starting.delete(id);
              if (accepted) finish(id, occurrenceId, "error", failure instanceof Error ? failure.message : String(failure));
              else reject(failure);
            });
        });
        options.log?.("routine.started", { routineId: id });
        return { runId, conversationId: routine.conversationId };
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (BUSY.test(message)) throw new RoutineError(message, 409);
        failedToStart(id, occurrenceId, message);
        throw new RoutineError(message, 500);
      } finally {
        if (!accepted) starting.delete(id);
      }
    },
  };

  /** The last minute the clock looked at; minutes after it and up to now are due. */
  let checked = Math.floor(now().getTime() / MINUTE) - 1;

  /**
   * One clock step: runs every enabled routine whose schedule names a minute since the last
   * step. A late step (a busy event loop) still covers a few missed minutes; after a pause or a
   * clock jump the older minutes are skipped, never caught up. The occurrence id is the UTC
   * minute, so a step repeated for the same minute is refused by `run` like any duplicate.
   */
  const tick = async () => {
    if (store.error) return; // Settings reports the error; a broken clock must not stop ordinary chat.
    const current = Math.floor(now().getTime() / MINUTE);
    const from = Math.max(checked + 1, current - CLOCK_LOOKBACK + 1);
    checked = Math.max(checked, current);
    const runs: Promise<unknown>[] = [];
    for (let minute = from; minute <= current; minute += 1) {
      const at = new Date(minute * MINUTE);
      for (const routine of store.list()) {
        if (!routine.enabled || !cronMatches(routine.schedule, routine.timezone, at)) continue;
        const occurrenceId = `at-${at.toISOString().slice(0, 16).replace(/[-:]/g, "")}Z`;
        runs.push(service.run(routine.id, occurrenceId).catch((failure: unknown) => {
          // Refusals (busy, already run, switched off) are expected; failures are already on the routine.
          options.log?.("routine.clock_skipped", { routineId: routine.id, occurrenceId, error: failure instanceof Error ? failure.message : String(failure) });
        }));
      }
    }
    await Promise.all(runs);
  };

  return {
    ...service,
    tick,
    /** Starts the host's clock (ADR-036); returns the function that stops it. */
    startClock() {
      const timer = setInterval(() => void tick(), CLOCK_INTERVAL);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

export type RoutineService = ReturnType<typeof createRoutineService>;
