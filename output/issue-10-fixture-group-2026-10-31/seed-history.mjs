import { createConversationStore } from "../../src/pi/conversationStore.ts";
import { createPiEventAdapter } from "../../src/harness/adapters/piAdapter.ts";

const root = process.argv[2];
if (!root || !/\/raytone-issue10\.[A-Za-z0-9]+$/.test(root)) throw new Error("Expected this task's disposable directory");
const store = createConversationStore(`${root}/data`);
const custom = "bot_01234567-89ab-cdef-0123-456789abcdef";
const participants = [
  { id: custom, presetId: "planner", name: "Archivist" },
  { id: "assistant", presetId: "assistant", name: "Historical Raer" },
];
for (const entry of [
  { id: "group_archivist", title: "Historical group", empty: false },
  { id: "group_archivist_empty", title: "Empty historical group", empty: true },
]) {
  store.begin(entry.id, "assistant", "");
  store.setExtra(entry.id, {
    title: entry.title, titleSource: "user", botId: "assistant", availableBots: participants,
    group: { members: [custom, "assistant"], participants, hostId: "assistant", lines: [] },
  });
  if (!entry.empty) {
    const adapter = createPiEventAdapter({ runId: `${entry.id}_test`, now: 1 });
    for (const event of [...adapter.startUserMessage("Historical identity display check"), ...adapter.finish()]) store.append(entry.id, event);
  }
  store.flush(entry.id);
}
console.log("Created two synthetic groups with the host second; no model calls.");
