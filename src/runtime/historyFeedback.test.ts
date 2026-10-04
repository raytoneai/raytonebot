import assert from "node:assert/strict";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createEphemeralPiConversation, replacePiConversation } from "../pi/piConversationState.ts";
import { historyFeedbackEvents } from "./historyFeedback.ts";

test("new events keep all restored and unsent conversations discoverable past 100 rows", () => {
  const conversations = Array.from({ length: 205 }, (_, index) => createEphemeralPiConversation(`saved-${index}`, index));
  const draft = createEphemeralPiConversation("unsent-draft");
  const restored = replacePiConversation(conversations, draft);
  assert.equal(restored.length, 206);
  const updated = replacePiConversation(restored, { ...conversations[204], title: "New reply" });
  assert.equal(updated.length, 206);
  assert.equal(updated[0].title, "New reply");
  assert.equal(updated.find((entry) => entry.id === draft.id), draft);
  assert.ok(conversations.every((entry) => updated.some((row) => row.id === entry.id)));
});

test("history errors render through the existing error view without altering transcript or replay cursor", () => {
  const adapter = createPiEventAdapter({ runId: "saved-run" });
  adapter.startUserMessage("Keep my saved message");
  adapter.finish("success");
  const canonical = JSON.parse(JSON.stringify(adapter.events));
  const cursor = canonical.length;
  const display = historyFeedbackEvents(canonical, "conversation", "History unavailable; select again to retry.");
  const view = createAgentUXViewModel(display);
  assert.ok(view.timeline.some((item) => item.kind === "error" && item.code === "history_load_failed"));
  assert.ok(view.timeline.some((item) => item.kind === "message" && item.text.includes("Keep my saved message")));
  assert.equal(canonical.length, cursor);
  assert.deepEqual(canonical, adapter.events);
  assert.equal(display.at(-1)?.seq, cursor + 1);
  const recovered = historyFeedbackEvents(canonical, "conversation");
  assert.equal(recovered, canonical);
  assert.equal(createAgentUXViewModel(recovered).errors.length, 0);
});

test("an unconfirmed submission stays visible without becoming a saved turn or advancing the reconnect cursor", () => {
  const adapter = createPiEventAdapter({ runId: "saved" });
  adapter.startUserMessage("Earlier message"); adapter.finish("success");
  const canonical = JSON.stringify(adapter.events), cursor = adapter.events.length;
  const display = historyFeedbackEvents(adapter.events, "conversation", {
    message: "Host state unknown; reopen to retry.", prompt: "Unconfirmed message", runId: "pending",
  });
  const view = createAgentUXViewModel(display);
  assert.ok(view.timeline.some(item => item.kind === "message" && item.text === "Unconfirmed message"));
  assert.ok(view.timeline.some(item => item.kind === "error" && item.message === "Host state unknown; reopen to retry."));
  assert.equal(JSON.stringify(adapter.events), canonical);
  assert.equal(adapter.events.length, cursor);
  assert.equal(historyFeedbackEvents(adapter.events, "conversation"), adapter.events);
});
