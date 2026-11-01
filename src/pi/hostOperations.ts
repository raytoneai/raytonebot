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

const eventFields: Record<string, ReadonlySet<string>> = {
  "run.started": new Set(["conversationId", "harness"]),
  "run.ended": new Set(["conversationId", "harness", "status", "durationMs", "outputBytes"]),
  "run.limit": new Set(["conversationId", "harness", "limit"]),
  "run.checkpoint_failed": new Set(["conversationId", "harness"]),
  "run.subscriber_failed": new Set(["conversationId", "status"]),
  "approval.resolved": new Set(["conversationId", "decision"]),
  "channel.connected": new Set(["platform"]), "channel.connect_failed": new Set(["platform"]),
  "channel.run_failed": new Set(["platform"]), "channel.message_failed": new Set(["platform"]),
  "conversation.titled": new Set(["conversationId"]), "conversation.title_failed": new Set(["conversationId", "status"]),
  "browser.input_batch": new Set(["count", "durationMs"]), "runtime.cleanup_failed": new Set(["conversationId", "status"]),
  "group.subscriber_failed": new Set(["conversationId", "runId"]), "group.finalize_failed": new Set(["conversationId", "runId"]),
  "group.delegate_notification_failed": new Set(["conversationId", "runId"]), "group.title_failed": new Set(["conversationId", "runId"]),
  "group.route": new Set(["conversationId", "mode", "source", "route", "rounds", "ms"]),
  "group.intro": new Set(["conversationId"]), "group.joined": new Set(["conversationId"]), "group.confirm": new Set(["conversationId"]),
  "routine.save_failed": new Set(["routineId"]), "routine.finished": new Set(["routineId", "status", "disabled"]),
  "routine.created": new Set(["routineId"]), "routine.started": new Set(["routineId"]),
  "routine.clock_history_failed": new Set(["routineId"]), "routine.clock_skipped": new Set(["routineId", "occurrenceId"]),
  "memory.added": new Set(["memoryId", "scope", "conversationId", "agent", "botId"]), "memory.removed": new Set(["memoryId"]),
  "mcp.listed": new Set(["serverId", "tools"]), "mcp.list_failed": new Set(["serverId"]),
  "mcp.updated": new Set(["serverId"]), "mcp.added": new Set(["serverId"]), "mcp.removed": new Set(["serverId"]),
  "browser.stopped": new Set(), "browser.download_started": new Set(["owned"]), "browser.download_blocked": new Set(),
  "browser.downloaded": new Set(["bytes"]), "browser.exited": new Set(["code"]), "browser.started": new Set(["sandboxed"]),
  "browser.state_save_failed": new Set(), "browser.egress_denied": new Set(),
};

function safeRuntimeValue(key: string, value: unknown): boolean {
  const numericFields = ["durationMs", "outputBytes", "count", "bytes", "code", "rounds", "ms", "tools"];
  if (key === "code" && value === null) return true;
  if (numericFields.includes(key)) return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (["owned", "disabled", "sandboxed"].includes(key)) return typeof value === "boolean";
  if (typeof value !== "string") return false;
  const maxLength = key === "conversationId" ? 160 : 128;
  if (value.length > maxLength) return false;
  const enums: Record<string, readonly string[]> = {
    harness: ["pi", "claude-code", "codex", "dsh"],
    status: ["success", "error", "cancelled", "interrupted", "running", "storage", "empty", "request", "bridge", "run-stop", "gateway", "failed", "skipped"],
    limit: ["duration", "output", "modelRequests"], decision: ["yes", "always", "no"],
    platform: ["telegram", "feishu", "wecom", "dingtalk"],
    mode: ["single", "parallel", "sequential", "mention", "round_robin", "discussion", "intro"],
    source: ["mention", "router", "fallback", "rule"],
    route: ["raer", "tonny", "bob", "parallel", "round_robin", "discussion", "plan_build_review", "plan_then_build", "build_then_review", "unclear"],
    agent: ["assistant", "planner", "builder", "dsh"],
  };
  if (key === "scope") return value === "global" || /^(bot|group):[a-zA-Z0-9_.:-]+$/.test(value);
  if (enums[key]) return enums[key].includes(value);
  if (["conversationId", "runId", "routineId", "occurrenceId", "memoryId", "botId", "serverId"].includes(key)) return value.length > 0 && /^[a-zA-Z0-9_.:-]+$/.test(value);
  return false;
}

/** Metadata only: enforce the boundary at runtime; callers may pass wider objects than their TS types. */
export function runtimeLogger(dataDir: string) {
  const file = join(dirname(dataDir), "logs", "runtime.jsonl");
  return (event: string, fields: Record<string, unknown> = {}) => {
    if (!Object.hasOwn(eventFields, event)) return;
    try {
      const allowed = eventFields[event];
      const safeFields = Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed.has(key) && safeRuntimeValue(key, value)));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // ponytail: two bounded files suit one user; use the host log collector if longer audit retention is needed.
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= 10 * 1024 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), event, ...safeFields })}\n`, { mode: 0o600 });
    } catch {
      // Logging failure must not turn a completed tool action into a failed/replayed task.
      process.stderr.write('{"event":"runtime.log_failed"}\n');
    }
  };
}
