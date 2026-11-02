import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ObserverLogRecord, ObserverRoutineStats } from "./queries.ts";
import type { RoutineView } from "../routineTypes.ts";
/** Metadata allowlist from the bounded tail; never forward a log record wholesale. */
export function observerLogRecords(dataDir: string): ObserverLogRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(join(dirname(dataDir), "logs/runtime.jsonl"), "r");
    const size = fstatSync(fd).size, start = Math.max(0, size - 256 * 1024), buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const segment = `runtime:${fstatSync(fd).dev}:${fstatSync(fd).ino}`; let offset = start;
    return buffer.toString("utf8").split("\n").flatMap((line, index) => {
      const position = offset; offset += Buffer.byteLength(line) + 1;
      if (start && index === 0) return [];
      try {
        const value = JSON.parse(line), at = Date.parse(value.time);
        if (!Number.isFinite(at) || typeof value.event !== "string") return [];
        const item: ObserverLogRecord = { id: `${segment}:${position}`, segment, at, event: value.event.slice(0, 100) };
        for (const key of ["conversationId", "runId", "code", "status", "tool", "decision"] as const) if (typeof value[key] === "string" && /^[a-zA-Z0-9_.:~-]{1,320}$/.test(value[key])) item[key] = value[key];
        if (Number.isSafeInteger(value.durationMs) && value.durationMs >= 0) item.durationMs = value.durationMs;
        if (Number.isSafeInteger(value.count) && value.count >= 0) item.count = value.count;
        return [item];
      } catch { return []; }
    });
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function observerRoutineStats(routines: RoutineView[]): ObserverRoutineStats[] {
  return routines.map(routine => ({ id: routine.id, botId: routine.botId, failureCount: routine.failures, history: (routine.history ?? []).map(run => ({ at: run.at, status: run.status,
    ...(typeof run.finishedAt === "number" && run.finishedAt >= run.at ? { durationMs: run.finishedAt - run.at } : {}), conversationId: routine.conversationId, ...(run.runId ? { runId: run.runId } : {}) })) }));
}
