import test from "node:test";
import assert from "node:assert/strict";
import { createEphemeralPiConversation, piConversationSidebarItems } from "../pi/piConversationState.ts";
import { groupSessionHistory } from "./useSessionHistoryGroups.ts";

test("history groups preserve role identity and recency, keeping group chats and unknown roles separate", () => {
  const sessions = piConversationSidebarItems([
    { ...createEphemeralPiConversation("bob-new"), agentPreset: "builder" },
    { ...createEphemeralPiConversation("group_shared"), agentPreset: "assistant" },
    { ...createEphemeralPiConversation("rae"), agentPreset: "assistant" },
    { ...createEphemeralPiConversation("tonny"), agentPreset: "planner" },
    { ...createEphemeralPiConversation("bob-old"), agentPreset: "builder" },
    createEphemeralPiConversation("legacy"),
    { ...createEphemeralPiConversation("unknown"), agentPreset: "retired-bot" },
  ]);
  assert.deepEqual(groupSessionHistory(sessions).map(group => [group.id, group.items.map(item => item.id)]), [
    ["assistant", ["rae"]], ["planner", ["tonny"]], ["builder", ["bob-new", "bob-old"]],
    ["group", ["group_shared"]], ["other", ["legacy", "unknown"]],
  ]);
  assert.deepEqual(groupSessionHistory([]), []);
  assert.deepEqual(groupSessionHistory([sessions[0]]).map(group => group.id), ["builder"]);
});
