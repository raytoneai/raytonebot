import test from "node:test";
import assert from "node:assert/strict";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { pendingUserInput, userInputEventsForReplay, userQuestions } from "./userInput.ts";

test("real adapter question history is readable, clears waiting, and leaves other runs' tools intact", () => {
  const adapter = createPiEventAdapter({ runId: "question-run" });
  const questions = userQuestions([{ question: "Language?", options: [{ label: "中文" }, { label: "English" }] }], "claude");
  adapter.startUserMessage("Original prompt");
  adapter.apply({ type: "tool_execution_start", toolCallId: "question", toolName: "AskUserQuestion", args: { questions } });
  adapter.apply({ type: "user_input_required", requestId: "input", toolCallId: "question", questions });
  assert.equal(createAgentUXViewModel(userInputEventsForReplay(adapter.events)).status, "awaiting_input");
  adapter.apply({ type: "user_input_resolved", requestId: "input", toolCallId: "question", questions, answers: { q0: ["中文"] } });
  const replay = userInputEventsForReplay(adapter.events);
  assert.equal(pendingUserInput(replay), undefined);
  const view = createAgentUXViewModel(replay);
  assert.equal(view.status, "running");
  assert.equal(view.timeline.some((item) => item.kind === "tool"), false);
  assert.ok(replay.some((e) => e.type === "text.delta" && e.payload.delta === "Language?\n中文"));
  const otherTool = { runId: "other", type: "tool.call.started", payload: { toolCallId: "question", name: "read" } };
  assert.ok(userInputEventsForReplay([...adapter.events, otherTool]).includes(otherTool));
  adapter.finish("cancelled");
  assert.equal(pendingUserInput(adapter.events), undefined);
});
