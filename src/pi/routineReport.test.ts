import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { HostTools } from "./memories.ts";
import type { PiRuntimeController } from "./piHost.ts";
import { createRoutineService, RoutineStore } from "./routines.ts";
import { createRoutineReportTools, parseRoutineReport, validRoutineReport } from "./routineReport.ts";

const definition = { id: "fixture", name: "Fixture", protocol: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:1/v1", models: ["fixture"], authMode: "none" as const };
const noChanges = { status: "no_changes", summary: "No new items after checking the source." };
const changes = { status: "changes", summary: "One new item.", evidence: [{ label: "Source", reference: "Unverified display reference" }] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rtb-routine-report-"));
  type Call = { tools: HostTools; runId: string; closed: boolean; emit(type: string, payload: Record<string, unknown>): void; finish(status: string): void };
  const calls: Call[] = [];
  let timestamp = 1_000;
  const runtime: Pick<PiRuntimeController, "configure" | "runPrompt" | "getConversation"> = {
    async configure() { return {} as never; }, getConversation() { return undefined; },
    async runPrompt(input, onEvent, options) {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const call: Call = { tools: options!.extraHostTools!, runId: input.requestId!, closed: false,
        emit(type, payload) { onEvent({ type, runId: input.requestId, payload } as AgentUXEvent); },
        finish(status) { if (call.closed) return; call.closed = true;
          call.emit(status === "error" ? "run.error" : "run.finished", status === "error" ? { message: "Host failed" } : { status }); release(); },
      };
      calls.push(call); call.emit("run.started", {});
      await pending;
    },
  };
  const service = createRoutineService({ dataDir: dir, runtime, permissionMode: "request", now: () => new Date(timestamp) });
  const routine = service.create({ title: "Check source", schedule: "0 9 * * *", timezone: "UTC", instructions: "Check fresh data.",
    fromConversationId: "chat", model: { definition, model: "fixture" } });
  service.update(routine.id, { enabled: true });
  const settled = () => new Promise<void>(resolve => setImmediate(resolve));
  return { dir, service, routine, calls, runtime, settled, now(value: number) { timestamp = value; },
    async start(occurrence = "first") { await service.run(routine.id, occurrence); return calls.at(-1)!; },
    read() { return service.list()[0]; },
    disk() { return JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).routines[0]; },
    async cleanup() { for (const call of calls) call.finish("cancelled"); await settled(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("report input is bounded plain text and rejects caller identity/timestamps and unknown fields", async () => {
  assert.deepEqual(parseRoutineReport({ ...noChanges, summary: `  ${noChanges.summary}  `, evidence: [] }), noChanges);
  assert.equal(validRoutineReport({ ...noChanges, reportedAt: 0 }), true);
  for (const bad of [
    { ...noChanges, routineId: "forged" }, { ...noChanges, occurrenceId: "forged" }, { ...noChanges, runId: "forged" },
    { ...noChanges, reportedAt: 1 }, { ...noChanges, identity: {} }, { ...noChanges, status: "success" }, { ...noChanges, status: ["changes"] },
    { ...noChanges, summary: " " }, { ...noChanges, summary: "x".repeat(1001) },
    { ...noChanges, evidence: Array(9).fill({ label: "source", reference: "text" }) },
    { ...noChanges, evidence: [{ label: "x".repeat(121), reference: "text" }] },
    { ...noChanges, evidence: [{ label: "source", reference: "x".repeat(1001) }] },
    { ...noChanges, evidence: [{ label: "source", reference: "text", verified: true }] },
  ]) assert.throws(() => parseRoutineReport(bad));
  assert.equal(validRoutineReport({ ...noChanges, reportedAt: NaN }), false);
  assert.equal(validRoutineReport({ ...noChanges, reportedAt: 1, runId: "forged" }), false);
  let called = false;
  const tools = createRoutineReportTools(input => { called = true; return { ...input, reportedAt: 1 }; });
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await tools.run("routine_report", noChanges, aborted.signal)).isError, true);
  assert.equal(called, false);
});

test("first durable report wins, identical active retries are idempotent and conflicting reports cannot overwrite it", async () => {
  const f = fixture();
  try {
    const call = await f.start();
    const first = await call.tools.run("routine_report", changes);
    assert.equal(first.isError, false);
    const saved = { ...changes, reportedAt: 1_000 };
    assert.deepEqual(f.disk().lastRun.report, saved, "successful tool receipt requires bytes already on disk");
    assert.deepEqual(f.read().history?.[0].report, saved);
    f.now(2_000);
    const retry = await call.tools.run("routine_report", changes);
    assert.deepEqual(retry, first);
    assert.equal((await call.tools.run("routine_report", noChanges)).isError, true);
    assert.deepEqual(f.disk().lastRun.report, saved);
    assert.equal(f.read().lastRun?.status, "running");
    assert.equal(f.read().failures, 0);
    call.finish("success"); await f.settled();
    assert.equal(f.read().lastRun?.status, "success");
    assert.deepEqual(f.read().lastRun?.report, saved);
    assert.equal((await call.tools.run("routine_report", changes)).isError, true, "even identical retries expire after the host terminal");
  } finally { await f.cleanup(); }
});

test("failed saves never acknowledge or reserve a report, and a later retry can persist it", async () => {
  const f = fixture();
  try {
    const call = await f.start();
    mkdirSync(join(f.dir, "routines.json.tmp"));
    assert.equal((await call.tools.run("routine_report", noChanges)).isError, true);
    assert.equal(f.read().lastRun?.report, undefined);
    assert.equal(f.disk().lastRun.report, undefined);
    rmSync(join(f.dir, "routines.json.tmp"), { recursive: true, force: true });
    assert.equal((await call.tools.run("routine_report", changes)).isError, false);
    assert.equal(f.disk().lastRun.report.status, "changes");
  } finally { await f.cleanup(); }
});

test("terminal cancellation, replacement and deletion reject late callbacks", async () => {
  const f = fixture();
  try {
    const first = await f.start();
    first.emit("run.finished", { status: "cancelled" });
    assert.equal((await first.tools.run("routine_report", noChanges)).isError, true, "a terminal closes reports before the runtime promise settles");
    first.finish("cancelled"); await f.settled();
    const second = await f.start("second");
    assert.equal((await first.tools.run("routine_report", noChanges)).isError, true);
    assert.equal(f.read().lastRun?.occurrenceId, "second");
    assert.equal(f.read().lastRun?.report, undefined);
    f.service.remove(f.routine.id);
    assert.equal((await second.tools.run("routine_report", changes)).isError, true);
    assert.equal(f.service.list().length, 0);
    second.finish("success"); await f.settled();
    assert.equal(f.service.list().length, 0, "late finish never resurrects a deleted routine");
  } finally { await f.cleanup(); }
});

for (const [report, status, failures] of [
  [noChanges, "error", 1], [{ status: "blocked", summary: "Source cannot be reached." }, "success", 0], [changes, "cancelled", 0],
] as const) test(`host ${status} remains independent of model self-report ${report.status}`, async () => {
  const f = fixture();
  try {
    const call = await f.start();
    assert.equal((await call.tools.run("routine_report", report)).isError, false);
    call.finish(status); await f.settled();
    assert.equal(f.read().lastRun?.status, status);
    assert.equal(f.read().lastRun?.report?.status, report.status);
    assert.equal(f.read().failures, failures);
    const reopened = createRoutineService({ dataDir: f.dir, runtime: f.runtime, permissionMode: "request" });
    assert.equal(reopened.list()[0].lastRun?.report?.status, report.status);
    assert.equal(reopened.list()[0].lastRun?.status, status);
  } finally { await f.cleanup(); }
});

test("restart preserves a running occurrence's report while marking host interruption, and legacy no-report stays absent", async () => {
  const f = fixture();
  try {
    const call = await f.start();
    await call.tools.run("routine_report", noChanges);
    const reopened = new RoutineStore(join(f.dir, "routines.json")).get(f.routine.id)!;
    assert.equal(reopened.lastRun?.status, "interrupted");
    assert.deepEqual(reopened.lastRun?.report, { ...noChanges, reportedAt: 1_000 });
    assert.deepEqual(reopened.history?.[0].report, reopened.lastRun?.report);
    call.finish("success"); await f.settled();
    const second = await f.start("second"); second.finish("success"); await f.settled();
    assert.equal(f.read().lastRun?.report, undefined, "natural-language completion never fabricates a report");
    assert.equal(f.read().history?.[1].report?.status, "no_changes");
    const data = f.disk();
    data.lastRun.report = { ...noChanges, reportedAt: 1, routineId: "forged" };
    writeFileSync(join(f.dir, "routines.json"), JSON.stringify({ routines: [data] }));
    assert.throws(() => new RoutineStore(join(f.dir, "routines.json")).list(), /could not be read/);
  } finally { await f.cleanup(); }
});


test("atomic rename failure cannot acknowledge a report or replace the previous durable state", async () => {
  const f = fixture();
  try {
    const call = await f.start();
    const file = join(f.dir, "routines.json"), previous = join(f.dir, "previous.json");
    renameSync(file, previous); mkdirSync(file);
    assert.equal((await call.tools.run("routine_report", changes)).isError, true);
    assert.equal(f.read().lastRun?.report, undefined);
    rmSync(file, { recursive: true, force: true }); renameSync(previous, file);
    assert.equal(f.disk().lastRun.report, undefined);
    assert.equal((await call.tools.run("routine_report", changes)).isError, false);
    assert.deepEqual(f.disk().lastRun.report, { ...changes, reportedAt: 1_000 });
  } finally { await f.cleanup(); }
});

test("no_changes reports do not hide repeated host failures or prevent the existing failure pause", async () => {
  const f = fixture();
  try {
    for (const occurrence of ["first", "second"]) {
      const call = await f.start(occurrence);
      assert.equal((await call.tools.run("routine_report", noChanges)).isError, false);
      call.finish("error"); await f.settled();
    }
    assert.equal(f.read().failures, 2);
    assert.equal(f.read().enabled, false);
    assert.equal(f.read().lastRun?.status, "error");
    assert.equal(f.read().lastRun?.report?.status, "no_changes");
  } finally { await f.cleanup(); }
});
