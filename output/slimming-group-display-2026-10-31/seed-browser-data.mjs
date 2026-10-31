// Test-only data, created through the existing store in an explicit disposable directory.
// Synthetic completed records; no model calls. Never run against the product data directory.
import { createConversationStore } from "../../src/pi/conversationStore.ts";
import { createPiEventAdapter } from "../../src/harness/adapters/piAdapter.ts";

const dataDir = process.argv[2];
if (!dataDir || !dataDir.startsWith("/tmp/raytone-group-display.")) throw new Error("Expected this task's temporary data directory");
const store = createConversationStore(dataDir);
const customId = "bot_01234567-89ab-cdef-0123-456789abcdef";
const participants = [
  { id: "assistant", name: "Historical Raer", presetId: "assistant" },
  { id: customId, name: "Archivist", presetId: "planner" },
];
const cases = [
  { id: "group_preview", title: "Me, Raer, Tonny", preview: "  最新进展\n  已完成  " },
  { id: "group_roster", title: "Me, Raer, Tonny" },
  { id: "group_named", title: "发布计划", titleSource: "user", preview: "不应替换手工标题" },
  { id: "group_summary", title: "摘要标题", titleSource: "summary", preview: "不应替换摘要标题" },
  { id: "group_preserved", title: "Me, Raer, Tonny", preserveTitle: true, preview: "不应替换保留标题" },
];
for (const entry of cases) {
  store.begin(entry.id, "assistant", "");
  store.setExtra(entry.id, {
    title: entry.title,
    ...(entry.titleSource ? { titleSource: entry.titleSource } : {}),
    botId: "assistant",
    availableBots: participants,
    group: {
      members: ["assistant", customId], participants, hostId: "assistant", lines: [],
      preserveTitle: entry.preserveTitle ?? false,
      ...(entry.preview ? { preview: { author: customId, text: entry.preview } } : {}),
    },
  });
  if (!store.get(entry.id).events.length) {
    const adapter = createPiEventAdapter({ runId: `${entry.id}_display_check`, now: 1 });
    for (const event of [...adapter.startUserMessage("显示回归测试记录"), ...adapter.finish()]) store.append(entry.id, event);
    store.flush(entry.id);
  }
}
console.log(`Created ${cases.length} completed test groups with historical/custom names.`);
