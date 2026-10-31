import { createConversationStore } from "../../src/pi/conversationStore.ts";
import { createPiEventAdapter } from "../../src/harness/adapters/piAdapter.ts";

const root = process.argv[2];
if (!root || !/\/raytone-shell-pure\.[A-Za-z0-9]+$/.test(root)) throw new Error("Expected this task's disposable directory");
const store = createConversationStore(`${root}/data`);
const custom = "bot_01234567-89ab-cdef-0123-456789abcdef";
const participants = [
  { id: "assistant", presetId: "assistant", name: "Historical Raer" },
  { id: custom, presetId: "planner", name: "Archivist" },
];
for (const entry of [
  { id: "pi_archivist", preset: "planner", title: "Archived Bot conversation", botId: custom },
  { id: "group_archivist", preset: "assistant", title: "Historical group", botId: "assistant" },
]) {
  store.begin(entry.id, entry.preset, "");
  store.setExtra(entry.id, {
    title: entry.title, titleSource: "user", botId: entry.botId, availableBots: participants,
    ...(entry.id.startsWith("group_") ? { group: { members: ["assistant", custom], participants, hostId: "assistant", lines: [] } } : {}),
  });
  const adapter = createPiEventAdapter({ runId: `${entry.id}_test`, now: 1 });
  for (const event of [...adapter.startUserMessage("Historical identity display check"), ...adapter.finish()]) store.append(entry.id, event);
  store.flush(entry.id);
}
console.log("Created two completed synthetic conversations; no model calls.");
