import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AppLocale } from "../i18n/locales.ts";
import type { ChannelModel } from "./imChannels/types.ts";
import type { PiPermissionMode, PiRuntimeController } from "./piHost.ts";
import { ROUTINE_FAILURE_LIMIT, type RoutineRunStatus, type RoutineView } from "./routineTypes.ts";

/**
 * Routines (ADR-033): saved instructions Raer runs on a schedule. The host keeps the definitions
 * and a run entry that is safe to call twice; an outside scheduler decides when (ADR-016), so
 * nothing here keeps time. Each routine runs in its own ordinary conversation, as Raer, with the
 * host's default permission mode and the server's environment key, like an IM chat.
 */

export type Routine = Omit<RoutineView, "model"> & {
  /** The model service of the turn that created it; definitions hold no secrets. */
  model?: ChannelModel;
  locale?: AppLocale;
  /** Occurrences already accepted, newest last. Kept with the routine, so deleting or resetting
   *  its conversation cannot make an old occurrence run again. */
  occurrences?: string[];
};

export type RoutineRequest = { title: string; schedule: string; timezone: string; instructions: string };
export type RoutineCreateInput = RoutineRequest & { fromConversationId: string; model?: ChannelModel; locale?: AppLocale };

export class RoutineError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

/** Five-field cron (minute hour day month weekday): `*`, numbers, ranges, lists and steps. */
export function cronProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "Use five fields: minute hour day month weekday.";
  for (const [index, field] of fields.entries()) {
    const [min, max] = CRON_FIELDS[index];
    for (const part of field.split(",")) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!match) return `"${field}" is not a valid cron field.`;
      const from = match[2] === undefined ? min : Number(match[2]);
      const to = match[3] === undefined ? (match[2] === undefined ? max : from) : Number(match[3]);
      const step = match[4] === undefined ? 1 : Number(match[4]);
      if (from < min || to > max || from > to || step < 1) return `"${field}" is out of range ${min}-${max}.`;
    }
  }
  return undefined;
}

function timezoneProblem(timezone: string): string | undefined {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return undefined; }
  catch { return `"${timezone}" is not an IANA timezone, e.g. Asia/Shanghai.`; }
}

/** `routines.json` in the bot's data directory, written whole through a temp file. */
export class RoutineStore {
  private routines: Routine[] = [];
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { routines?: Routine[] };
      this.routines = (parsed.routines ?? []).filter((routine) => routine && typeof routine.id === "string")
        // A run in flight when the host stopped is not resumed or replayed.
        .map((routine) => routine.lastRun?.status === "running"
          ? { ...routine, lastRun: { ...routine.lastRun, status: "interrupted" as const } } : routine);
    } catch {
      // Missing or unreadable: no routines. Nothing runs until one is created again.
    }
  }

  list() { return this.routines.map((routine) => structuredClone(routine)); }
  get(id: string) { const routine = this.routines.find((item) => item.id === id); return routine && structuredClone(routine); }

  put(routine: Routine) {
    const next = [...this.routines.filter((item) => item.id !== routine.id), routine].sort((a, b) => a.createdAt - b.createdAt);
    this.save(next);
    this.routines = next;
  }

  remove(id: string) {
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
  return { ...routine, ...(model ? { model: { provider: model.definition.id, model: model.model } } : {}) };
}

export function routinePrompt(routine: Routine, occurrenceId: string, now: Date): string {
  return [
    `[Routine "${routine.title}" · run ${occurrenceId} · ${now.toISOString()} · schedule ${routine.schedule} ${routine.timezone}]`,
    "This is an unattended scheduled run; the user is not watching now. Fetch fresh data every time and do not rely on earlier runs. If nothing is worth reporting, say so in one line.",
    `Task:\n${routine.instructions}`,
  ].join("\n\n");
}

const OCCURRENCE = /^[A-Za-z0-9._-]{1,80}$/;
/** Accepted occurrences remembered per routine; a scheduler replaying older ones is out of contract. */
const OCCURRENCE_MEMORY = 500;
/** Refusals that are not the routine's fault: they never count towards switching it off. */
const BUSY = /already|in progress|Stop this conversation/i;

export function createRoutineService(options: {
  dataDir?: string;
  runtime: Pick<PiRuntimeController, "runPrompt" | "configure" | "getConversation">;
  permissionMode: PiPermissionMode;
  log?(event: string, fields: Record<string, unknown>): void;
  now?(): Date;
}) {
  const store = new RoutineStore(options.dataDir ? join(options.dataDir, "routines.json") : undefined);
  const now = options.now ?? (() => new Date());
  /** Routines between acceptance checks and their run's slot; a second call is busy at once. */
  const starting = new Set<string>();

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
    if (!record({ ...routine, failures, lastRun: { ...routine.lastRun, status, ...(error ? { error } : {}) },
      ...(stop ? { enabled: false, disabledReason: error ?? "Failed twice in a row." } : {}) })) return;
    options.log?.("routine.finished", { routineId: id, status, ...(stop ? { disabled: true } : {}) });
  };

  /** A run that failed before it started (configuration, storage) still counts as a failure. */
  const failedToStart = (id: string, occurrenceId: string, error: string) => {
    const routine = store.get(id);
    if (!routine) return;
    if (record({ ...routine, lastRun: { occurrenceId, at: now().getTime(), status: "running" } })) finish(id, occurrenceId, "error", error);
  };

  return {
    list: () => store.list().map(routineView),

    create(input: RoutineCreateInput): RoutineView {
      const title = input.title?.trim(), instructions = input.instructions?.trim();
      const schedule = input.schedule?.trim().split(/\s+/).join(" "), timezone = input.timezone?.trim();
      if (input.fromConversationId.startsWith("routine-")) throw new RoutineError("A routine run cannot create routines.", 400);
      if (!title || title.length > 80) throw new RoutineError("A title of 1-80 characters is required.", 400);
      if (!instructions || instructions.length > 4000) throw new RoutineError("Instructions of 1-4000 characters are required.", 400);
      const problem = (schedule ? cronProblem(schedule) : "A schedule is required.") ?? (timezone ? timezoneProblem(timezone) : "A timezone is required.");
      if (problem) throw new RoutineError(problem, 400);
      // Never fall back to another model: a routine runs only on the service it was made with.
      if (!input.model) throw new RoutineError("This conversation has no configured model service. Choose one in Settings → Model services, then ask again.", 400);
      const id = randomUUID().slice(0, 8);
      // Created switched off: "clocks stay Disabled until I hit Enable".
      const routine: Routine = { id, title, schedule: schedule!, timezone: timezone!, instructions, enabled: false,
        createdAt: now().getTime(), conversationId: `routine-${id}`, failures: 0,
        model: input.model, ...(input.locale ? { locale: input.locale } : {}) };
      store.put(routine);
      options.log?.("routine.created", { routineId: id });
      return routineView(routine);
    },

    update(id: string, patch: { enabled?: unknown }): RoutineView {
      const routine = required(id);
      if (typeof patch.enabled !== "boolean") throw new RoutineError("enabled must be true or false.", 400);
      const next: Routine = patch.enabled
        ? { ...routine, enabled: true, failures: 0, disabledReason: undefined }
        : { ...routine, enabled: false };
      store.put(next);
      return routineView(next);
    },

    remove(id: string) {
      if (!store.remove(id)) throw new RoutineError("Routine not found.", 404);
    },

    /**
     * The scheduler's entry: resolves once the run is accepted and keeps it going in the
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
        await options.runtime.configure({ conversationId: routine.conversationId, providerDefinition: model.definition,
          provider: model.definition.id, model: model.model });
        let status: RoutineRunStatus = "error", error: string | undefined;
        await new Promise<void>((resolve, reject) => {
          const onEvent = (event: AgentUXEvent) => {
            if (!accepted) {
              accepted = true;
              starting.delete(id);
              const current = store.get(id);
              // On a failed disk the conversation's saved turn still guards this occurrence; the run goes on.
              if (current) record({ ...current, lastRun: { occurrenceId, at: now().getTime(), status: "running" },
                occurrences: [...(current.occurrences ?? []), occurrenceId].slice(-OCCURRENCE_MEMORY) });
              resolve();
            }
            if (event.type === "run.finished") status = String((event.payload as { status?: unknown }).status ?? "success") as RoutineRunStatus;
            if (event.type === "run.error") {
              status = "error";
              error = String((event.payload as { message?: unknown }).message ?? "").trim() || undefined;
            }
          };
          options.runtime.runPrompt({ conversationId: routine.conversationId, requestId: runId, agentPreset: "assistant",
            prompt: routinePrompt(routine, occurrenceId, now()), permissionMode: options.permissionMode,
            provider: model.definition.id, model: model.model,
            ...(routine.locale ? { locale: routine.locale } : {}) }, onEvent, { title: routine.title }).then(
            () => { if (accepted) finish(id, occurrenceId, status, error); else reject(new Error("The run ended before it started.")); },
            (failure: unknown) => {
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
}

export type RoutineService = ReturnType<typeof createRoutineService>;
