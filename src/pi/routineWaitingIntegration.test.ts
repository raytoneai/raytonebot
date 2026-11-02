import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import type { PiRuntimeController } from "./piHost.ts";
import { createConversationStore } from "./conversationStore.ts";
import { createRoutineService } from "./routines.ts";

test("routine waiting view isolates the active run, keeps legacy age unknown and clears after release or terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-routine-waiting-view-"));
  const conversations = createConversationStore(dir);
  let activeRunId: string | undefined, awaiting = true, release!: () => void;
  let emit!: (event: AgentUXEvent) => void;
  const runtime: Pick<PiRuntimeController, "configure" | "runPrompt" | "getConversation" | "awaitingUser"> = {
    async configure() { return {} as never; }, awaitingUser() { return awaiting; },
    getConversation(id) { const saved = conversations.get(id); return saved ? { ...saved, incomplete: false, activeRunId } : undefined; },
    async runPrompt(input, onEvent) {
      emit = onEvent; activeRunId = input.requestId;
      conversations.begin(input.conversationId!, "assistant", input.prompt);
      const event = { type: "run.started", runId: input.requestId, payload: {} };
      conversations.append(input.conversationId!, event); onEvent(event);
      await new Promise<void>(resolve => { release = resolve; });
    },
  };
  const service = createRoutineService({ dataDir: dir, runtime, permissionMode: "request" });
  const routine = service.create({ title: "Wait", schedule: "0 9 * * *", timezone: "UTC", instructions: "Check fresh data", fromConversationId: "chat",
    model: { definition: { id: "fixture", name: "Fixture", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", models: ["fixture"], authMode: "none" }, model: "fixture" } });
  service.update(routine.id, { enabled: true });
  try {
    const { runId } = await service.run(routine.id, "first");
    const view = () => service.list()[0];
    const append = (type: string, payload: Record<string, unknown>) => conversations.append(routine.conversationId, { type, runId, payload, ts: 1 });
    assert.equal(view().lastRun?.waiting, true, "a real gate without a recorded event still shows an unknown wait");
    assert.equal(view().lastRun?.waitingDetails, undefined);
    append("tool.call.awaiting_approval", { toolCallId: "approval" });
    assert.deepEqual(view().lastRun?.waitingDetails, { reasons: ["approval"], count: 1 }, "legacy event.ts is not a host-observed wait age");
    activeRunId = "different-run";
    assert.equal(view().lastRun?.waiting, undefined);
    assert.equal(view().history?.[0].waitingDetails, undefined);
    activeRunId = runId;
    awaiting = false;
    assert.equal(view().lastRun?.waiting, undefined);
    assert.equal(view().lastRun?.waitingDetails, undefined);
    assert.equal(view().history?.[0].waiting, undefined);
    awaiting = true;
    append("run.awaiting_input", { requestId: "question", waitObservedAt: 500 });
    assert.equal(view().lastRun?.waitingDetails?.since, undefined, "one unknown active approval keeps the combined age unknown");
    append("tool.call.finished", { toolCallId: "approval", status: "success" });
    assert.deepEqual(view().lastRun?.waitingDetails, { reasons: ["question"], count: 1, since: 500 });
    append("run.finished", { status: "success" });
    assert.equal(view().lastRun?.status, "running", "the live runtime has not settled yet");
    assert.equal(view().lastRun?.waiting, undefined, "a real terminal prevents a stale gate from showing a wait");
    assert.equal(view().history?.[0].waitingDetails, undefined);
    emit({ type: "run.finished", runId, payload: { status: "success" } });
  } finally {
    release?.(); await new Promise<void>(resolve => setImmediate(resolve)); rmSync(dir, { recursive: true, force: true });
  }
});
