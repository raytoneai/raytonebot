import assert from "node:assert/strict";
import test from "node:test";

import type { EphemeralPiConversation } from "../pi/piConversationState.ts";
import { groupFields, groupMembersOf } from "./groupConversationView.ts";

const conversation = (groupMembers?: string[]): EphemeralPiConversation => ({
  id: "group_test",
  title: "Group",
  createdAt: 0,
  events: [],
  ...(groupMembers ? { groupMembers } : {}),
});

test("groupFields preserves the distinction between false and missing group metadata", () => {
  const participants = [{ id: "bot_01234567-89ab-cdef-0123-456789abcdef", name: "A renamed Bot", presetId: "assistant" as const }];
  const members = ["assistant", participants[0].id];
  const entry = {
    botId: "assistant",
    availableBots: participants,
    titleSource: "user" as const,
    group: { members, participants, hostId: participants[0].id, preserveTitle: false, preview: { author: "assistant", text: "hello" } },
  };
  const before = structuredClone(entry);

  assert.deepEqual(groupFields(entry), {
    botId: "assistant",
    availableBots: participants,
    titleSource: "user",
    groupMembers: members,
    groupParticipants: participants,
    groupHostId: participants[0].id,
    groupTitlePreserved: false,
    groupPreview: { author: "assistant", text: "hello" },
  });
  assert.deepEqual(entry, before);
});

test("groupFields omits absent optional fields and only carries availableBots with botId", () => {
  const availableBots = [{ id: "bot_01234567-89ab-cdef-0123-456789abcdef", name: "A renamed Bot", presetId: "assistant" as const }];
  assert.deepEqual(groupFields({ availableBots, titleSource: "" }), {});
  assert.deepEqual(groupFields({ titleSource: "summary" }), { titleSource: "summary" });
});

test("groupFields explicitly clears absent participant, host, and preview values for a present group", () => {
  const fields = groupFields({ group: { members: [] } });
  assert.deepEqual(fields, {
    groupMembers: [],
    groupParticipants: undefined,
    groupHostId: undefined,
    groupPreview: undefined,
  });
});

test("groupMembersOf filters invalid IDs without reordering or deduplicating, then falls back when empty", () => {
  const customId = "bot_01234567-89ab-cdef-0123-456789abcdef";
  assert.deepEqual(groupMembersOf(conversation(["assistant", "invalid", customId, "assistant"])),
    ["assistant", customId, "assistant"]);
  assert.deepEqual(groupMembersOf(conversation(["invalid"])), ["assistant", "planner", "builder"]);
  assert.deepEqual(groupMembersOf(conversation()), ["assistant", "planner", "builder"]);
});
