/** Routines as the settings page sees them (ADR-033). Shared by server and browser; no Node imports. */

export type RoutineRunStatus = "running" | "success" | "error" | "cancelled" | "interrupted";

export type RoutineView = {
  id: string;
  title: string;
  /** Five-field cron, read by the host's clock in `timezone`. */
  schedule: string;
  timezone: string;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  /** The routine's own conversation; every run continues it. */
  conversationId: string;
  /** Errors in a row; reaching `ROUTINE_FAILURE_LIMIT` switches the routine off. */
  failures: number;
  disabledReason?: string;
  lastRun?: { occurrenceId: string; at: number; status: RoutineRunStatus; error?: string;
    /** Running, and held for an approval or a question in its conversation: nobody is watching it. */
    waiting?: boolean };
  model?: { provider: string; model: string };
};

export const ROUTINE_FAILURE_LIMIT = 2;
