import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type RunLimits = { durationMs: number; outputBytes: number; modelRequests: number };

export function runLimits(env: NodeJS.ProcessEnv = process.env): RunLimits {
  const positive = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  return {
    durationMs: positive("RAYTONEBOT_RUN_TIMEOUT_MS", 30 * 60 * 1000),
    outputBytes: positive("RAYTONEBOT_RUN_OUTPUT_BYTES", 10 * 1024 * 1024),
    modelRequests: positive("RAYTONEBOT_RUN_MODEL_REQUESTS", 100),
  };
}

/** Metadata only: never accept prompts, tool args/results, provider URLs, or raw errors. */
export function runtimeLogger(dataDir: string) {
  const file = join(dirname(dataDir), "logs", "runtime.jsonl");
  return (event: "run.started" | "run.ended" | "run.limit" | "run.checkpoint_failed" | "approval.resolved", fields: {
    conversationId: string; harness?: string; status?: string; durationMs?: number; outputBytes?: number;
    limit?: "duration" | "output" | "modelRequests"; decision?: string;
  }) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // ponytail: two bounded files suit one user; use the host log collector if longer audit retention is needed.
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= 10 * 1024 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
    } catch {
      // Logging failure must not turn a completed tool action into a failed/replayed task.
      process.stderr.write('{"event":"runtime.log_failed"}\n');
    }
  };
}
