import assert from "node:assert/strict";
import test from "node:test";

import type { AgentUXEvent } from "@agent-ux/protocol";
import type { EphemeralPiConversation } from "../pi/piConversationState.ts";
import { groupConversationFaces, groupConversationPreviews, groupConversationTitle, groupFields, groupMembersOf, groupTypingMember } from "./groupConversationView.ts";

const conversation = (groupMembers?: string[]): EphemeralPiConversation => ({
  id: "group_test",
  title: "Group",
  createdAt: 0,
  events: [],
  ...(groupMembers ? { groupMembers } : {}),
});

const typingEvent = (type: string, payload?: unknown, fields: Record<string, unknown> = {}): AgentUXEvent =>
  ({ type, payload, ...fields } as unknown as AgentUXEvent);

test("groupTypingMember returns no member outside groups and ignores invalid starts", () => {
  const events = [
    typingEvent("group.member.started", { member: "assistant" }),
    typingEvent("group.member.started", { member: "invalid" }),
    typingEvent("group.member.started", null),
  ];
  const before = structuredClone(events);

  assert.equal(groupTypingMember({ ...conversation(), id: "ordinary_conversation" }, events), undefined);
  assert.equal(groupTypingMember(conversation(["assistant"]), events), "assistant");
  assert.deepEqual(events, before);
});

test("groupTypingMember clears on output IDs from all supported event families", () => {
  const cases: Array<[string, AgentUXEvent]> = [
    ["text.started messageId", typingEvent("text.started", {}, { messageId: "assistant~message" })],
    ["tool.call.running toolCallId", typingEvent("tool.call.running", { toolCallId: "assistant~tool" })],
    ["text.delta textId", typingEvent("text.delta", { textId: "assistant~text" })],
    ["reasoning.started reasoningId", typingEvent("reasoning.started", { reasoningId: "assistant~reasoning" })],
    ["artifact.delta artifactId", typingEvent("artifact.delta", { artifactId: "assistant~artifact" })],
  ];
  for (const [label, output] of cases) {
    assert.equal(groupTypingMember(conversation(["assistant"]), [
      typingEvent("group.member.started", { member: "assistant" }), output,
    ]), undefined, label);
  }
});

test("groupTypingMember keeps the latest member until matching output or a run terminal", () => {
  const events = [
    typingEvent("group.member.started", { member: "assistant" }),
    typingEvent("group.member.started", { member: "planner" }),
    typingEvent("text.delta", { textId: "assistant~older-output" }),
    typingEvent("custom.event", null),
  ];
  const before = structuredClone(events);
  assert.equal(groupTypingMember(conversation(["assistant", "planner"]), events), "planner");
  assert.deepEqual(events, before);

  for (const terminal of ["run.finished", "run.error"]) {
    assert.equal(groupTypingMember(conversation(["assistant"]), [
      typingEvent("group.member.started", { member: "assistant" }),
      typingEvent(terminal, null),
    ]), undefined, terminal);
  }
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

test("groupConversationTitle refreshes roster titles from current names while recognizing legacy names in every locale", () => {
  const customId = "bot_01234567-89ab-cdef-0123-456789abcdef";
  const entry: EphemeralPiConversation = {
    ...conversation([customId, "planner"]),
    title: "Me, Raer, Tonny",
    groupParticipants: [{ id: customId, name: "Old custom name", presetId: "assistant" }, { id: "planner", name: "Old planner name", presetId: "planner" }],
  };
  const configuredBots = [{ id: customId, name: "Avery" }];
  const legacyName = (id: string) => id === customId ? "Raer" : "Tonny";
  const before = structuredClone(entry);

  assert.equal(groupConversationTitle(entry, "en", configuredBots, legacyName), "Me, Avery, Old planner name");
  assert.equal(groupConversationTitle({ ...entry, title: "我、Raer、Tonny" }, "zh", configuredBots, legacyName), "我、Avery、Old planner name");
  assert.equal(groupConversationTitle({ ...entry, title: "自分、Raer、Tonny" }, "ja", configuredBots, legacyName), "自分、Avery、Old planner name");
  assert.equal(groupConversationTitle({ ...entry, title: "自分、Raer、Tonny" }, "en", configuredBots, legacyName), "Me, Avery, Old planner name");
  assert.equal(groupConversationTitle({ ...entry, title: "自分、Raer、Tonny", groupParticipants: undefined }, "en", [], legacyName), `Me, ${customId}, planner`);
  assert.deepEqual(entry, before);
});

test("groupConversationTitle keeps manual, summary, preserved, and non-group titles intact", () => {
  const base = { ...conversation(["assistant", "planner"]), title: "Me, Raer, Tonny" };
  const configuredBots = [{ id: "assistant", name: "Avery" }];
  const legacyName = (id: string) => id === "assistant" ? "Raer" : "Tonny";
  for (const entry of [
    { ...base, titleSource: "user" as const },
    { ...base, titleSource: "summary" as const },
    { ...base, groupTitlePreserved: true },
    { ...base, title: "Project notes" },
    { ...base, id: "ordinary_conversation", groupMembers: undefined },
  ]) {
    assert.equal(groupConversationTitle(entry, "en", configuredBots, legacyName), entry.title);
  }
});

test("groupConversationPreviews only replaces unprotected roster titles and normalizes preview whitespace", () => {
  const group = (id: string, overrides: Partial<EphemeralPiConversation> = {}): EphemeralPiConversation => ({
    ...conversation(["assistant", "planner"]), id, title: "Me, Raer, Tonny",
    groupPreview: { author: "assistant", text: "  hello\n  from\tgroup  " }, ...overrides,
  });
  const entries = [
    group("eligible"),
    group("custom-names", { title: "Me, Avery, Pip" }),
    group("user-title", { titleSource: "user" }),
    group("summary-title", { titleSource: "summary" }),
    group("preserved-title", { groupTitlePreserved: true }),
    group("not-a-roster", { title: "Project notes" }),
    group("no-preview", { groupPreview: undefined }),
    { ...group("plain"), id: "plain_conversation", groupMembers: undefined },
  ];
  const before = structuredClone(entries);
  const currentName = (id: string) => id === "assistant" ? "Avery" : "Pip";
  const legacyName = (id: string) => id === "assistant" ? "Raer" : "Tonny";

  assert.deepEqual(groupConversationPreviews(entries, currentName, legacyName), {
    eligible: "hello from group",
    "custom-names": "hello from group",
  });
  assert.deepEqual(entries, before);
});

test("groupConversationFaces preserves filtered member order and duplicates, defaults empty groups, and excludes regular conversations", () => {
  const customId = "bot_01234567-89ab-cdef-0123-456789abcdef";
  const entries = [
    conversation(["planner", "invalid", customId, "planner"]),
    { ...conversation(["invalid"]), id: "group_empty" },
    { ...conversation(), id: "ordinary_conversation" },
  ];
  const before = structuredClone(entries);
  const avatars = { assistant: "woman", planner: "man", builder: "boy", dsh: "woman" } as const;

  assert.deepEqual(groupConversationFaces(entries, avatars, id => id === customId ? "builder" : id as "assistant" | "planner" | "builder" | "dsh"), {
    group_test: ["man", "boy", "man"],
    group_empty: ["woman", "man", "boy"],
  });
  assert.deepEqual(entries, before);
});
