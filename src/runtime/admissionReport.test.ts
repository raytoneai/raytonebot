import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { admitEvents, describeAdmission } from "./admissionReport.ts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function event(type: string, id: string, payload: Record<string, unknown> = {}): AgentUXEvent {
  return { protocol: "agent-ux", version: "0.1", id, runId: "run-1", ts: 1, type: type as AgentUXEvent["type"], payload };
}

test("admission is a read-only preview of normalization and derivation", () => {
  const input = deepFreeze([
    event("run.started", "run-started"),
    event("tool.call.started", "tool-started", {
      toolCallId: "tool-1",
      name: "write",
      title: 'write {"path":"notes.md"}',
      args: { path: "notes.md", content: "hello" },
    }),
    event("tool.call.running", "tool-running", {
      toolCallId: "tool-1",
      args: { path: "notes.md", content: "hello" },
    }),
    event("tool.call.finished", "tool-finished", {
      toolCallId: "tool-1",
      status: "success",
    }),
    event("vendor.unknown", "unknown", { secret: "not-replayed" }),
  ]);
  const inputBefore = structuredClone(input);
  const replayBefore = JSON.parse(JSON.stringify(createAgentUXViewModel(replayAgentUXEvents(input))));

  const admission = admitEvents(input);

  assert.deepEqual(input, inputBefore, "the frozen source remains unchanged");
  assert.deepEqual(JSON.parse(JSON.stringify(createAgentUXViewModel(replayAgentUXEvents(input)))), replayBefore, "actual replay projection remains unchanged");
  assert.deepEqual(admission.normalize.canonicalizedNames, [{ toolCallId: "tool-1", from: "write", to: "write_file" }]);
  assert.deepEqual(admission.normalize.derivedArtifacts, [{ toolCallId: "tool-1", path: "notes.md" }]);
  assert.equal(admission.normalize.rejected[0]?.reason, "unknown-type");
  assert.equal(admission.normalize.rejected[0]?.event, input[4]);
  assert.equal(admission.normalize.events[1]?.payload && (admission.normalize.events[1].payload as { name?: string }).name, "write_file");
  assert.ok(admission.events.some((item) => item.type === "artifact.finished"), "preview includes derived artifact events");
  const report = describeAdmission(admission);
  assert.match(report, /未观测\/未覆盖/);
  assert.doesNotMatch(report, /不建议上生产/);

  const waiting = describeAdmission(admitEvents([
    event("run.started", "waiting-run"),
    event("tool.call.started", "waiting-tool", { toolCallId: "waiting-tool", name: "write" }),
  ]));
  assert.match(waiting, /若该回合已结束/);
  assert.match(waiting, /运行中或等待审批时可正常存在/);

  admitEvents(input);
  assert.deepEqual(input, inputBefore, "running the preview never rewrites the replay input");
});
