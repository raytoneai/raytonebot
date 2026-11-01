import assert from "node:assert/strict";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { piCancelledTurnEvents } from "../pi/piCancelledTurn.ts";
import { appendPiConversationEvents, createEphemeralPiConversation } from "../pi/piConversationState.ts";
import { cancelledTurnsForReplay } from "./cancelledTurns.ts";
import { identityEventForReplay } from "./replayIdentity.ts";
import type { AppLocale } from "../i18n/locales.ts";

function partial(runId: string) {
  const adapter = createPiEventAdapter({ runId });
  adapter.startUserMessage(`Question ${runId}`);
  adapter.apply({ type: "message_start", message: { role: "assistant" } });
  adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } });
  return adapter;
}

for (const [locale, label] of [["en", "Run stopped"], ["zh", "本轮已停止"], ["ja", "実行停止"]] as const) {
  test(`cancelled history reload retains a visible localized stop marker and partial answer (${locale})`, () => {
    const adapter = partial("stopped");
    adapter.finish("cancelled"); // The actual adapter terminal, without synthetic cancellation ids.
    const conversation = appendPiConversationEvents(createEphemeralPiConversation("stopped-chat"), adapter.events);
    const saved = JSON.stringify(conversation);
    const loaded = JSON.parse(saved) as typeof conversation;
    const projected = cancelledTurnsForReplay(loaded.events, locale);
    const view = createAgentUXViewModel(replayAgentUXEvents(projected.map(identityEventForReplay)));
    assert.equal(view.status, "finished");
    assert.equal(view.timeline.filter(item => item.kind === "step" && item.status === "cancelled").length, 1);
    assert.equal(view.timeline.at(-1)?.label, label);
    assert.equal(view.timeline.at(-1)?.summary, undefined, "unknown cancellation reason is never attributed to restart or the user");
    assert.ok(view.timeline.some(item => item.kind === "message" && item.text === "Partial answer"));
    assert.deepEqual(cancelledTurnsForReplay(projected, locale), projected, "repeated projection is idempotent");
    assert.equal(JSON.stringify(loaded), saved, "display events never change the raw transcript, identities or cursor");
    for (const event of loaded.events) {
      const replayed = projected.find(candidate => candidate.id === event.id);
      assert.equal(replayed?.messageId, event.messageId);
      assert.equal(replayed?.runId, event.runId);
      assert.deepEqual(replayed?.payload, event.payload);
    }
  });
}

test("successful turns have no stop marker and stop markers remain in their own turn", () => {
  const first = partial("first");
  const closing = piCancelledTurnEvents(first.events);
  const second = partial("second"); second.finish("success");
  let conversation = appendPiConversationEvents(createEphemeralPiConversation("chat"), [...first.events, ...closing]);
  conversation = appendPiConversationEvents(conversation, second.events);
  const view = createAgentUXViewModel(replayAgentUXEvents(cancelledTurnsForReplay(conversation.events, "en")));
  const markers = view.timeline.filter(item => item.kind === "step");
  assert.equal(markers.length, 1);
  const markerIndex = view.timeline.indexOf(markers[0]);
  assert.equal(view.timeline[markerIndex + 1].text, "Question second");
  assert.equal(view.timeline.filter(item => item.kind === "message").length, 4);
  assert.equal(cancelledTurnsForReplay(second.events, "en").filter(event => event.type === "step.finished").length, 0);
  assert.deepEqual(piCancelledTurnEvents(second.events, "host_restart"), [], "restart never rewrites a completed turn");
});

test("only a persisted explicit restart reason explains the interruption", () => {
  const adapter = partial("interrupted");
  const stop = piCancelledTurnEvents(adapter.events);
  const restart = piCancelledTurnEvents(adapter.events, "host_restart");
  assert.equal(stop.at(-1)?.id, restart.at(-1)?.id, "legacy ids alone do not identify the reason");
  for (const locale of ["en", "zh", "ja"] satisfies AppLocale[]) {
    const events = JSON.parse(JSON.stringify([...adapter.events, ...restart]));
    const view = createAgentUXViewModel(replayAgentUXEvents(cancelledTurnsForReplay(events, locale)));
    assert.ok(view.timeline.at(-1)?.summary);
    assert.equal(view.timeline.at(-1)?.status, "cancelled");
    const stopped = createAgentUXViewModel(replayAgentUXEvents(cancelledTurnsForReplay([...adapter.events, ...stop], locale)));
    assert.equal(stopped.timeline.at(-1)?.summary, undefined);
  }
  assert.deepEqual(piCancelledTurnEvents([...adapter.events, ...restart], "host_restart"), []);
});
