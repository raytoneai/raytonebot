import type { HostTools } from "./memories.ts";
import type { HostToolSpec } from "./mcpServers.ts";
import type { RoutineReport, RoutineReportInput } from "./routineTypes.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && value.trim().length > 0;

export function parseRoutineReport(value: unknown): RoutineReportInput {
  if (!record(value) || !keys(value, ["status", "summary", "evidence"])
    || typeof value.status !== "string" || !["changes", "no_changes", "blocked"].includes(value.status) || !text(value.summary, 1000)) {
    throw new Error("A routine report requires status changes, no_changes or blocked and a summary of 1-1000 characters; no identity or extra fields are accepted.");
  }
  if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length > 8 || value.evidence.some(item =>
    !record(item) || !keys(item, ["label", "reference"]) || !text(item.label, 120) || !text(item.reference, 1000)))) {
    throw new Error("Evidence must contain at most 8 plain-text entries with label (1-120 characters) and reference (1-1000 characters).");
  }
  return { status: value.status as RoutineReportInput["status"], summary: value.summary.trim(),
    ...(Array.isArray(value.evidence) && value.evidence.length ? { evidence: value.evidence.map(item => ({ label: item.label.trim(), reference: item.reference.trim() })) } : {}) };
}

export function validRoutineReport(value: unknown): value is RoutineReport {
  if (!record(value) || !keys(value, ["status", "summary", "evidence", "reportedAt"]) || typeof value.reportedAt !== "number" || !Number.isFinite(value.reportedAt) || value.reportedAt < 0) return false;
  try { parseRoutineReport({ status: value.status, summary: value.summary, ...(value.evidence !== undefined ? { evidence: value.evidence } : {}) }); return true; }
  catch { return false; }
}

export function sameRoutineReport(left: RoutineReportInput, right: RoutineReportInput): boolean {
  return JSON.stringify(parseRoutineReport({ status: left.status, summary: left.summary, ...(left.evidence ? { evidence: left.evidence } : {}) })) === JSON.stringify(right);
}

const spec: HostToolSpec = {
  name: "routine_report",
  description: "Optionally submit one structured self-report for this scheduled occurrence: changes, no_changes or blocked, with a short summary and optional evidence references. This is the model's report, not host verification; evidence is unverified display text. It does not mark the host run successful or reset failures. The host binds the routine, occurrence and run; do not supply identity or timestamps. The first saved report wins; identical retries are allowed while this occurrence is active. Call only after completing your checks; do not invent fresh evidence.",
  inputSchema: { type: "object", additionalProperties: false, required: ["status", "summary"], properties: {
    status: { type: "string", enum: ["changes", "no_changes", "blocked"] }, summary: { type: "string", minLength: 1, maxLength: 1000 },
    evidence: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["label", "reference"], properties: {
      label: { type: "string", minLength: 1, maxLength: 120 }, reference: { type: "string", minLength: 1, maxLength: 1000 },
    } } },
  } },
};

/** The callback acknowledges only after the occurrence-bound host store has committed. */
export function createRoutineReportTools(save: (input: RoutineReportInput) => RoutineReport): HostTools {
  return { specs: [spec], async run(name, args, signal) {
    try {
      if (name !== spec.name) throw new Error("Unknown routine report tool.");
      signal?.throwIfAborted();
      const report = save(parseRoutineReport(args));
      return { text: JSON.stringify({ report }), isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : "Routine report could not be saved.", isError: true };
    }
  } };
}
