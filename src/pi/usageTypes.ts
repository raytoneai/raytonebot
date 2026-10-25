import type { AgentHarnessId } from "./harnessCatalog.ts";

export const USAGE_RUN_LIMIT = 500;
export const USAGE_REQUEST_LIMIT = 100;
export const USAGE_TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
export type UsageTokenField = typeof USAGE_TOKEN_FIELDS[number];
export type UsageTokens = Partial<Record<UsageTokenField, number>>;
/** Input includes reported cache; cache counts are subsets, never added again. Missing input components make coverage partial. */
export type ModelUsage = UsageTokens & { source: "gateway"; complete: boolean };
export type UsageStart = {
  runId: string; conversationId: string; botId: string; harness: AgentHarnessId;
  provider?: string; model?: string; startedAt?: number;
};
export type UsageStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type UsageRun = Omit<UsageStart, "startedAt"> & {
  startedAt: number; endedAt?: number; status: UsageStatus; source: "gateway";
  /** Counts describe retained requests; truncated means the per-run retention limit was reached. */
  requestCount: number; knownRequestCount: number; completeRequestCount: number; truncated: boolean;
  coverage: "complete" | "partial" | "unknown";
  /** Known contributions only. Check tokenRequests/coverage before presenting a total as complete. */
  totals: UsageTokens;
  tokenRequests: Record<UsageTokenField, number>;
};
export type UsageState = { runs: UsageRun[]; storageError?: string };
