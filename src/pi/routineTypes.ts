/** Routines as the settings page sees them (ADR-033). Shared by server and browser; no Node imports. */

export type RoutineRunStatus = "running" | "success" | "error" | "cancelled" | "interrupted";

export type RoutineRun = { occurrenceId: string; at: number; status: RoutineRunStatus; error?: string;
  runId?: string; textId?: string; finishedAt?: number;
  /** Running, and held for approval or a question in its conversation. */
  waiting?: boolean };

export type RoutineDefinitionPatch = { title: string; instructions: string; schedule: string; timezone: string; revision: number };

export type RoutineView = {
  id: string;
  /** Stable creator identity; older routines belong to assistant. */
  botId?: string;
  title: string;
  /** Five-field cron, read by the host's clock in `timezone`. */
  schedule: string;
  timezone: string;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  /** Definition revision; legacy records start at zero. Executions do not change it. */
  revision?: number;
  /** Next planned UTC timestamp within 366 days; absent while disabled or without a match. */
  nextRunAt?: number;
  /** The routine's own conversation; every run continues it. */
  conversationId: string;
  /** Errors in a row; reaching `ROUTINE_FAILURE_LIMIT` switches the routine off. */
  failures: number;
  disabledReason?: string;
  lastRun?: RoutineRun;
  /** A due time was skipped, without creating or replaying a turn. */
  lastSkipped?: { at: number; detectedAt: number; reason: "offline" | "busy" };
  /** Most recent first, at most ROUTINE_HISTORY_LIMIT entries. */
  history?: RoutineRun[];
  model?: { provider: string; model: string };
};

export const ROUTINE_FAILURE_LIMIT = 2;
export const ROUTINE_HISTORY_LIMIT = 20;
