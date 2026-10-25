import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAgentHarnessId } from "./harnessCatalog.ts";
import { USAGE_REQUEST_LIMIT, USAGE_RUN_LIMIT, USAGE_TOKEN_FIELDS, type ModelUsage, type UsageRun, type UsageStart, type UsageState, type UsageStatus, type UsageTokens } from "./usageTypes.ts";

type StoredRun = Omit<UsageRun, "source" | "requestCount" | "knownRequestCount" | "completeRequestCount" | "coverage" | "totals" | "tokenRequests"> & { requests: Record<string, ModelUsage> };
type UsageFile = { version: 1; runs: StoredRun[] };
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const statuses: UsageStatus[] = ["running", "completed", "failed", "cancelled", "interrupted"];
const STORAGE_ERROR = "Usage history could not be saved. Recent usage is kept in memory; repair storage and restart to resume saving.";

function cleanUsage(value: unknown): ModelUsage | undefined {
  if (!object(value) || value.source !== "gateway" || typeof value.complete !== "boolean") return;
  const usage: ModelUsage = { source: "gateway", complete: value.complete };
  for (const field of USAGE_TOKEN_FIELDS) {
    if (value[field] === undefined) continue;
    if (!timestamp(value[field])) return;
    usage[field] = value[field];
  }
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) usage.complete = false;
  return usage;
}

function cleanStart(value: UsageStart, now: number): Required<Pick<UsageStart, "runId" | "conversationId" | "botId" | "harness" | "startedAt">> & Pick<UsageStart, "provider" | "model"> | undefined {
  if (!object(value) || !identity(value.runId) || !identity(value.conversationId) || !identity(value.botId) || !isAgentHarnessId(value.harness)
    || value.provider !== undefined && !label(value.provider) || value.model !== undefined && !label(value.model)
    || value.startedAt !== undefined && !timestamp(value.startedAt)) return;
  return { runId: value.runId, conversationId: value.conversationId, botId: value.botId, harness: value.harness,
    ...(value.provider !== undefined ? { provider: value.provider } : {}), ...(value.model !== undefined ? { model: value.model } : {}), startedAt: value.startedAt ?? now };
}

function restore(value: unknown): StoredRun[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > USAGE_RUN_LIMIT) throw new Error();
  const ids = new Set<string>();
  return value.runs.map(raw => {
    if (!object(raw)) throw new Error();
    const start = cleanStart(raw as UsageStart, 0);
    if (!start || !timestamp(raw.startedAt) || ids.has(JSON.stringify([start.conversationId, start.runId])) || !statuses.includes(raw.status as UsageStatus)
      || raw.endedAt !== undefined && !timestamp(raw.endedAt) || typeof raw.truncated !== "boolean" || !object(raw.requests)
      || Object.keys(raw.requests).length > USAGE_REQUEST_LIMIT) throw new Error();
    ids.add(JSON.stringify([start.conversationId, start.runId]));
    const requests = Object.fromEntries(Object.entries(raw.requests).map(([id, value]) => {
      const usage = cleanUsage(value);
      if (!identity(id) || !usage) throw new Error();
      return [id, usage];
    }));
    return { ...start, status: raw.status === "running" ? "interrupted" : raw.status as UsageStatus,
      ...(raw.endedAt !== undefined ? { endedAt: raw.endedAt as number } : {}), truncated: raw.truncated, requests };
  });
}

function view(run: StoredRun): UsageRun {
  const { requests, ...metadata } = run;
  const values = Object.values(requests), totals: UsageTokens = {};
  const tokenRequests = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let overflow = false;
  for (const field of USAGE_TOKEN_FIELDS) {
    let sum = 0;
    for (const usage of values) if (usage[field] !== undefined) {
      sum += usage[field];
      tokenRequests[field]++;
    }
    if (tokenRequests[field]) {
      if (Number.isSafeInteger(sum)) totals[field] = sum;
      else overflow = true;
    }
  }
  const knownRequestCount = values.filter(value => USAGE_TOKEN_FIELDS.some(field => value[field] !== undefined)).length;
  const completeRequestCount = values.filter(value => value.complete).length;
  return { ...metadata, source: "gateway", requestCount: values.length, knownRequestCount, completeRequestCount, totals, tokenRequests,
    coverage: !knownRequestCount ? "unknown" : !run.truncated && !overflow && values.length === completeRequestCount ? "complete" : "partial" };
}

/** Telemetry is best effort: a disk failure never changes task outcome or triggers a retry. */
export function createUsageService(options: { dataDir?: string; now?(): number } = {}) {
  const file = options.dataDir ? join(options.dataDir, "usage.json") : undefined;
  const now = options.now ?? Date.now;
  let runs: StoredRun[] = [], storageError: string | undefined;
  if (file) try {
    if (statSync(file).size > 20 * 1024 * 1024) throw new Error();
    runs = restore(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") storageError = "Usage history could not be read. Its original file is preserved; repair storage and restart to resume saving.";
  }
  const persist = () => {
    if (!file || storageError) return;
    let temporary: string | undefined;
    try {
      mkdirSync(options.dataDir!, { recursive: true });
      temporary = `${file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, runs } satisfies UsageFile)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file); temporary = undefined;
    } catch { storageError = STORAGE_ERROR; }
    finally { if (temporary) try { unlinkSync(temporary); } catch { /* No retry on failed telemetry storage. */ } }
  };
  const findRun = (runId: string, conversationId?: string) => {
    const matching = runs.filter(run => run.runId === runId && (conversationId === undefined || run.conversationId === conversationId));
    return matching.length === 1 ? matching[0] : undefined;
  };
  return {
    start(value: UsageStart): void {
      const start = cleanStart(value, now());
      if (!start || runs.some(run => run.runId === start.runId && run.conversationId === start.conversationId)) return;
      runs.unshift({ ...start, status: "running", truncated: false, requests: {} });
      runs = runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, USAGE_RUN_LIMIT);
      persist();
    },
    record(runId: string, requestId: string, value: ModelUsage, conversationId?: string): void {
      const run = findRun(runId, conversationId);
      if (!run || !identity(requestId) || !object(value)) return;
      const previous = Object.hasOwn(run.requests, requestId) ? run.requests[requestId] : undefined;
      const usage = cleanUsage({ ...previous, ...value });
      if (!usage) return;
      if (!Object.hasOwn(run.requests, requestId) && Object.keys(run.requests).length >= USAGE_REQUEST_LIMIT) {
        if (!run.truncated) { run.truncated = true; persist(); }
        return;
      }
      if (JSON.stringify(run.requests[requestId]) === JSON.stringify(usage)) return;
      Object.defineProperty(run.requests, requestId, { value: usage, enumerable: true, configurable: true, writable: true });
      persist();
    },
    end(runId: string, status: Exclude<UsageStatus, "running">, conversationId?: string): void {
      const run = findRun(runId, conversationId);
      if (!run || !statuses.includes(status) || status === ("running" as UsageStatus) || run.status !== "running") return;
      run.status = status; run.endedAt = now(); persist();
    },
    list(): UsageState { return { runs: runs.map(view), ...(storageError ? { storageError } : {}) }; },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
