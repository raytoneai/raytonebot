import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCronOccurrence, routineScheduleLabel } from "./routineSchedule.ts";

const next = (schedule: string, timezone: string, after: string) => {
  const at = nextCronOccurrence(schedule, timezone, Date.parse(after));
  return at === undefined ? undefined : new Date(at).toISOString();
};

test("next routine time uses its timezone, weekdays and an exclusive starting minute", () => {
  assert.equal(next("0 9 * * 1-5", "Asia/Shanghai", "2026-10-09T00:59:59Z"), "2026-10-09T01:00:00.000Z");
  assert.equal(next("0 9 * * 1-5", "Asia/Shanghai", "2026-10-09T01:00:00Z"), "2026-10-12T01:00:00.000Z");
  assert.equal(next("0 9 * * *", "Asia/Kathmandu", "2026-10-09T00:00:00Z"), "2026-10-09T03:15:00.000Z");
  assert.equal(next("5/20 * * * *", "UTC", "2026-10-09T01:45:00Z"), "2026-10-09T02:05:00.000Z");
  assert.equal(next("0 0 13 * 5", "UTC", "2026-10-08T23:00:00Z"), "2026-10-09T00:00:00.000Z");
});

test("next routine time skips DST gaps and preserves both repeated-clock occurrences", () => {
  assert.equal(next("30 2 * * *", "America/New_York", "2026-03-08T00:00:00Z"), "2026-03-09T06:30:00.000Z");
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T00:00:00Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z"), "2026-11-01T06:30:00.000Z");
  assert.equal(next("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z"), "2026-10-04T15:15:00.000Z");
});

test("next routine time is bounded and invalid schedules remain unavailable", () => {
  assert.equal(next("0 9 29 2 *", "UTC", "2027-03-01T00:00:00Z"), "2028-02-29T09:00:00.000Z");
  assert.equal(next("0 9 31 2 *", "UTC", "2026-10-09T00:00:00Z"), undefined);
  assert.equal(next("0 9 29 2 *", "UTC", "2026-10-09T00:00:00Z"), undefined);
  assert.equal(next("0 25 * * *", "UTC", "2026-10-09T00:00:00Z"), undefined);
  assert.equal(next("0 9 * * *", "invalid-zone", "2026-10-09T00:00:00Z"), undefined);
});

test("readable labels only summarize known schedules", () => {
  assert.equal(routineScheduleLabel("0 9 * * 1-5", "zh"), "工作日 09:00");
  assert.equal(routineScheduleLabel("30 8 * * 7", "en"), "Every Sunday 08:30");
  assert.equal(routineScheduleLabel("15 * * * *", "zh"), "每小时 15 分");
  assert.equal(routineScheduleLabel("0 9 1 * *", "zh"), "0 9 1 * *");
});
