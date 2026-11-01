import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRoutineService } from "./routines.ts";
import type { PiRuntimeController } from "./piHost.ts";

const model = {
  definition: {
    id: "clock-boundary",
    name: "Clock boundary",
    protocol: "openai-compatible" as const,
    baseUrl: "https://models.example.test/v1",
    models: ["flash"],
    authMode: "required" as const,
    apiKeyEnvVar: "CLOCK_BOUNDARY_API_KEY",
  },
  model: "flash",
};

class TestClock {
  private value: Date;
  constructor(iso: string) { this.value = new Date(iso); }
  set(iso: string) { this.value = new Date(iso); }
  now() { return this.value; }
}

function runtime(calls: string[]): Pick<PiRuntimeController, "runPrompt" | "configure" | "getConversation"> {
  return {
    configure: async () => ({} as never),
    getConversation: () => undefined,
    runPrompt: async (request, onEvent) => {
      const runId = String(request.requestId);
      calls.push(runId);
      const event = (type: string, payload: Record<string, unknown>, seq: number) => onEvent({
        protocol: "agent-ux", version: "0.1", id: `clock_${runId}_${seq}`, runId, seq, ts: Date.now(), type, payload,
      } as never);
      event("run.started", {}, 1);
      event("run.finished", { status: "success" }, 2);
    },
  };
}

function service(dataDir: string, clock: TestClock, calls: string[]) {
  return createRoutineService({ dataDir, runtime: runtime(calls), permissionMode: "request", now: () => clock.now() });
}

function cleanup(dataDir: string) {
  rmSync(dataDir, { recursive: true, force: true });
}

test("an enabled legacy routine without nextScheduledAt establishes a baseline instead of replaying startup history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-legacy-"));
  const clock = new TestClock("2026-10-09T10:00:30Z");
  const calls: string[] = [];
  try {
    let routines = service(dataDir, clock, calls);
    const routine = routines.create({ title: "Legacy", schedule: "0 10 * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    routines.update(routine.id, { enabled: true });
    const file = join(dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { routines: Record<string, unknown>[] };
    delete saved.routines[0].nextScheduledAt;
    writeFileSync(file, JSON.stringify(saved));

    calls.length = 0;
    routines = service(dataDir, clock, calls);
    clock.set("2026-10-09T10:01:00Z");
    await routines.tick();

    assert.deepEqual(calls, [], "the first clock check must not infer a pre-start 10:00 occurrence");
  } finally { cleanup(dataDir); }
});

test("enabling after the clock already checked the minute does not manufacture an offline skip", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-enable-"));
  const clock = new TestClock("2026-10-09T08:59:30Z");
  const calls: string[] = [];
  try {
    const routines = service(dataDir, clock, calls);
    const routine = routines.create({ title: "Enable", schedule: "0 9 * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    clock.set("2026-10-09T09:00:00Z");
    await routines.tick();
    clock.set("2026-10-09T09:00:30Z");
    routines.update(routine.id, { enabled: true });
    clock.set("2026-10-09T09:01:00Z");
    await routines.tick();

    assert.equal(routines.list()[0].lastSkipped, undefined);
    assert.deepEqual(calls, []);
  } finally { cleanup(dataDir); }
});

test("editing after the clock checked a minute does not manufacture an offline skip", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-edit-"));
  const clock = new TestClock("2026-10-09T08:59:30Z");
  const calls: string[] = [];
  try {
    const routines = service(dataDir, clock, calls);
    const routine = routines.create({ title: "Edit", schedule: "0 10 * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    routines.update(routine.id, { enabled: true });
    clock.set("2026-10-09T09:00:00Z");
    await routines.tick();
    clock.set("2026-10-09T09:00:30Z");
    routines.update(routine.id, { title: "Edit", instructions: "Check.", schedule: "0 9 * * *", timezone: "UTC", revision: routine.revision });
    clock.set("2026-10-09T09:01:00Z");
    await routines.tick();

    assert.equal(routines.list()[0].lastSkipped, undefined);
    assert.deepEqual(calls, []);
  } finally { cleanup(dataDir); }
});

test("re-enabling does not backfill minutes that were entirely disabled", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-disabled-"));
  const clock = new TestClock("2026-10-09T09:59:30Z");
  const calls: string[] = [];
  try {
    const routines = service(dataDir, clock, calls);
    const routine = routines.create({ title: "Disabled", schedule: "* * * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    routines.update(routine.id, { enabled: true });
    clock.set("2026-10-09T10:00:00Z");
    await routines.tick();
    calls.length = 0;
    clock.set("2026-10-09T10:00:30Z");
    routines.update(routine.id, { enabled: false });
    clock.set("2026-10-09T10:01:30Z");
    routines.update(routine.id, { enabled: true });
    clock.set("2026-10-09T10:02:00Z");
    await routines.tick();

    assert.equal(calls.some((id) => id.endsWith("at-20261009T1001Z")), false);
    assert.equal(calls.some((id) => id.endsWith("at-20261009T1002Z")), true);
  } finally { cleanup(dataDir); }
});

test("after a wall-clock rollback a new future occurrence runs, while an accepted occurrence is still deduplicated", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-routine-clock-rollback-"));
  const clock = new TestClock("2026-10-09T09:59:30Z");
  const calls: string[] = [];
  try {
    const routines = service(dataDir, clock, calls);
    const oldRoutine = routines.create({ title: "Old", schedule: "0 10 * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    routines.update(oldRoutine.id, { enabled: true });
    clock.set("2026-10-09T10:00:00Z");
    await routines.tick();
    assert.equal(calls.filter((id) => id.includes(oldRoutine.id) && id.endsWith("at-20261009T1000Z")).length, 1);

    clock.set("2026-10-09T10:10:00Z");
    await routines.tick();
    clock.set("2026-10-09T09:59:30Z");
    const newRoutine = routines.create({ title: "New", schedule: "0 10 * * *", timezone: "UTC", instructions: "Check.", fromConversationId: "chat", model });
    routines.update(newRoutine.id, { enabled: true });
    clock.set("2026-10-09T10:00:00Z");
    await routines.tick();

    assert.equal(calls.filter((id) => id.includes(oldRoutine.id) && id.endsWith("at-20261009T1000Z")).length, 1);
    assert.equal(calls.filter((id) => id.includes(newRoutine.id) && id.endsWith("at-20261009T1000Z")).length, 1);
  } finally { cleanup(dataDir); }
});
