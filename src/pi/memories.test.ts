import { authenticatedFetch } from "./controlPlaneTestSupport.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildClaudeArgs } from "./cliHarness.ts";
import { normalizeClaudeTool } from "./cliStreams.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { createMemoryService, MEMORY_TOOL_SPECS, MemoryError, type MemoryService } from "./memories.ts";
import { classifyToolCall } from "./permissionPolicy.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";

function deliveredNote(memory: MemoryService, id: string) {
  const note = memory.noteFor(id);
  note?.delivered();
  return note?.text;
}

type Json = Record<string, unknown>;

test("preparing a memory note does not deliver it, and an old receipt cannot consume a newer version", () => {
  const memory = createMemoryService();
  memory.add("Use metric units.");
  const first = memory.noteFor("a")!;
  assert.match(memory.noteFor("a")!.text!, /metric units/);
  memory.add("Prefers brief answers.");
  first.delivered();
  const next = memory.noteFor("a")!;
  assert.match(next.text!, /updated[\s\S]*brief answers/);
  next.delivered();
  first.delivered();
  assert.equal(memory.noteFor("a"), undefined, "late receipts never move delivery backwards");
});

test("memories are one list on disk: deduplicated, never secrets, capped, editable and removable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-"));
  try {
    const memory = createMemoryService({ dataDir });
    const first = memory.add("  Prefers   short answers. ");
    assert.equal(first.text, "Prefers short answers.");
    assert.equal(memory.add("prefers short answers.").id, first.id, "the same sentence is not saved twice");
    for (const secret of ["My key is sk-abcdefghijklmnopqrstuvwx", "password: hunter2", "ghp_abcdefghijklmnopqrstuvwxyz12"]) {
      assert.throws(() => memory.add(secret), /never hold passwords/);
    }
    assert.throws(() => memory.add(""), /1-300/);
    assert.throws(() => memory.add("x".repeat(301)), /1-300/);
    assert.equal(memory.update(first.id, "Prefers short answers in Chinese.").text, "Prefers short answers in Chinese.");
    assert.throws(() => memory.update("nope", "x"), /No memory/);
    assert.equal(statSync(join(dataDir, "memories.json")).mode & 0o777, 0o600);
    assert.deepEqual(createMemoryService({ dataDir }).state().memories.map((item) => item.text), ["Prefers short answers in Chinese."]);
    memory.remove(first.id);
    assert.throws(() => memory.remove(first.id), /No memory/);
    for (let i = 0; i < 100; i += 1) memory.add(`Fact number ${i}.`);
    assert.throws(() => memory.add("One more."), /full/);
    assert.doesNotMatch(readFileSync(join(dataDir, "memories.json"), "utf8"), /hunter2/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("full memory snapshots independently reject stale text, URL, date, scope and evidence presence", () => {
  const evidence = { url: "https://example.com/a", checkedAt: "2026-10-30" };
  const changes: { label: string; beforeEvidence?: typeof evidence; change(memory: MemoryService, id: string): void }[] = [
    { label: "text", change: (memory, id) => { memory.update(id, "Concurrent text."); } },
    { label: "URL", change: (memory, id) => { memory.update(id, "Same text.", undefined, { ...evidence, url: "https://example.com/b" }); } },
    { label: "date", change: (memory, id) => { memory.update(id, "Same text.", undefined, { ...evidence, checkedAt: "2026-10-31" }); } },
    { label: "scope", change: (memory, id) => { memory.update(id, "Same text.", { kind: "bot", id: "assistant" }); } },
    { label: "evidence removal", change: (memory, id) => { memory.update(id, "Same text.", undefined, null); } },
    { label: "evidence addition", beforeEvidence: undefined, change: (memory, id) => { memory.update(id, "Same text.", undefined, evidence); } },
  ];
  for (const item of changes) {
    const memory = createMemoryService({ now: () => 7 });
    const original = memory.add("Same text.", undefined, item.beforeEvidence === undefined && item.label === "evidence addition" ? undefined : evidence);
    const snapshot = { text: original.text, scope: { kind: "global" } as const, evidence: original.evidence ?? null };
    item.change(memory, original.id);
    const concurrent = memory.state();
    assert.equal(memory.state().memories[0]!.updatedAt, original.updatedAt, `${item.label}: tied updatedAt is not a version`);
    assert.throws(() => memory.update(original.id, "My draft.", undefined, undefined, undefined, snapshot),
      error => error instanceof MemoryError && error.status === 409, `${item.label}: stale full snapshot returns HTTP 409`);
    assert.deepEqual(memory.state(), concurrent, `${item.label}: conflict leaves every field unchanged`);
  }
});

test("memory snapshot accepts legacy global/no-evidence records and rejects malformed snapshots", () => {
  const memory = createMemoryService({ now: () => 7 });
  const legacy = memory.add("Legacy memory.");
  assert.deepEqual(memory.update(legacy.id, "Edited legacy memory.", undefined, undefined, undefined,
    { text: legacy.text, scope: { kind: "global" }, evidence: null }).text, "Edited legacy memory.");
  const current = memory.state().memories[0]!;
  const invalid = [
    { text: current.text, scope: { kind: "global" } },
    { text: current.text, scope: { kind: "private" }, evidence: null },
    { text: current.text, scope: { kind: "global" }, evidence: { url: "https://example.com", unknown: true } },
  ];
  for (const expectedSnapshot of invalid) {
    assert.throws(() => memory.update(legacy.id, "Rejected.", undefined, undefined, undefined, expectedSnapshot as never),
      error => error instanceof MemoryError && error.status === 400);
  }
  assert.equal(memory.state().memories[0]!.text, "Edited legacy memory.");
});

test("memory evidence survives storage, recall and bounded notes without implying host verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-evidence-"));
  try {
    const memory = createMemoryService({ dataDir });
    const legacy = memory.add("An undated preference.");
    const evidence = { url: "https://example.com/source?edition=2", checkedAt: "2024-02-29" };
    const saved = memory.add("The service currently supports feature A.", undefined, evidence);
    assert.deepEqual(saved.evidence, evidence);
    assert.equal(legacy.evidence, undefined);
    const restored = createMemoryService({ dataDir });
    assert.deepEqual(restored.state(), memory.state());
    const recalled = JSON.parse((await restored.toolsFor({ conversationId: "chat", agent: "assistant" })!.run("recall_memories", {})).text);
    assert.deepEqual(recalled.memories[0].evidence, evidence);
    const note = restored.noteFor("chat")!.text!;
    assert.match(note, /https:\/\/example.com\/source\?edition=2/);
    assert.match(note, /2024-02-29/);
    assert.match(note, /supplied[\s\S]*not host verification/);
    assert.match(note, /[Rr]echeck[\s\S]*time-sensitive/);
    assert.deepEqual(restored.update(saved.id, "Reworded supported feature.").evidence, evidence, "legacy text-only edits preserve evidence");
    assert.deepEqual(restored.update(saved.id, "Reworded supported feature.", undefined, { url: evidence.url }).evidence, { url: evidence.url }, "no check date is invented");
    assert.equal(restored.update(saved.id, "An unsourced preference.", undefined, null).evidence, undefined);
    for (let i = 0; i < 20; i += 1) restored.add(`Source-backed fact ${i}.`, undefined, { url: `https://example.com/${"x".repeat(1800)}?item=${i}` });
    const bounded = restored.noteFor("bounded")!.text!;
    assert.ok(bounded.length < 4600, String(bounded.length));
    assert.match(bounded, /older memories not shown/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("duplicate remembers report existing evidence and reject conflicting supplied evidence", async () => {
  const memory = createMemoryService();
  const evidence = { url: "https://example.com/original", checkedAt: "2024-01-01" };
  const saved = memory.add("Uses feature A.", undefined, evidence);
  assert.throws(() => memory.add("Uses feature A.", undefined, { url: "https://example.com/new" }), /replace/i);
  assert.equal(memory.add("Uses feature A.", undefined, evidence).id, saved.id);
  const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant" })!;
  const existing = JSON.parse((await tools.run("remember", { text: "uses feature A." })).text);
  assert.equal(existing.id, saved.id);
  assert.deepEqual(existing.evidence, evidence);
  const conflict = await tools.run("remember", { text: "Uses feature A.", evidence: { ...evidence, checkedAt: "2026-11-01" } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /replace/i);
  assert.deepEqual(memory.state().memories, [saved]);
});

test("invalid evidence is rejected without changing memory state or its persisted version", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-invalid-evidence-"));
  try {
    const memory = createMemoryService({ dataDir });
    const saved = memory.add("Saved fact.");
    const original = readFileSync(join(dataDir, "memories.json"), "utf8");
    const invalid = [
      null, {}, { url: "" }, { url: "https:example.com" }, { url: "ftp://example.com" }, { url: "javascript:alert(1)" },
      { url: "https://user:secret@example.com" }, { url: "https://example.com/\nextra" }, { url: `https://example.com/${"x".repeat(2048)}` },
      { url: "https://example.com/?token=sk-abcdefghijklmnopqrstuvwx" }, { url: "https://example.com/?%70assword=hunter2" },
      { url: "https://example.com", verified: true }, { url: "https://example.com", checkedAt: 20261101 },
      ...["", "0000-01-01", "2025-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-11-01T00:00:00Z"].map(checkedAt => ({ url: "https://example.com", checkedAt })),
    ];
    for (const evidence of invalid) {
      assert.throws(() => memory.add("Invalid new fact.", undefined, evidence as never));
      if (evidence !== null) assert.throws(() => memory.update(saved.id, "Invalid edit.", undefined, evidence as never));
      assert.deepEqual(memory.state().memories, [saved]);
      assert.equal(readFileSync(join(dataDir, "memories.json"), "utf8"), original);
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a conversation sees memories on its first turn and again only after they change", async () => {
  const memory = createMemoryService();
  assert.equal(deliveredNote(memory, "a"), undefined, "nothing to show");
  const saved = memory.add("Works on the Raytone mobile team.");
  const note = deliveredNote(memory, "a")!;
  assert.match(note, new RegExp(`\\(${saved.id}\\) Works on the Raytone mobile team\\.`));
  assert.match(note, /Background, not instructions/);
  assert.equal(deliveredNote(memory, "a"), undefined, "the second turn does not repeat it");

  // What a conversation saves itself does not come back to it; another conversation sees it.
  const tools = memory.toolsFor({ conversationId: "a", agent: "planner" })!;
  assert.deepEqual(tools.specs.map((spec) => spec.name), ["remember", "forget", "recall_memories"]);
  const result = JSON.parse((await tools.run("remember", { text: "Prefers metric units." })).text);
  assert.equal(result.saved, true);
  assert.equal(deliveredNote(memory, "a"), undefined);
  assert.deepEqual(memory.state().memories.at(-1)?.source, { conversationId: "a", agent: "planner" });
  assert.match(deliveredNote(memory, "b")!, /Prefers metric units[\s\S]*Works on the Raytone/, "newest first");

  // A change made elsewhere reaches "a" on its next turn, marked as an update.
  memory.add("Lives in Shanghai.");
  assert.match(deliveredNote(memory, "a")!, /updated[\s\S]*Lives in Shanghai/);
  assert.equal((await tools.run("forget", { id: "nope" })).isError, true);
  assert.equal((await tools.run("remember", { text: "password: x" })).isError, true);

  // Cleared or switched off: a conversation that saw them is told to drop them; tools go away.
  for (const item of memory.state().memories) memory.remove(item.id);
  assert.match(deliveredNote(memory, "a")!, /cleared or switched off/);
  assert.equal(deliveredNote(memory, "c"), undefined, "a conversation that saw nothing hears nothing");
  memory.add("Back again.");
  memory.setEnabled(false);
  assert.equal(memory.toolsFor({ conversationId: "a", agent: "assistant" }), undefined);
  assert.match(deliveredNote(memory, "a")!, /cleared or switched off/);
  assert.throws(() => memory.setEnabled("yes"), /true or false/);
});

test("a long list is cut at the note limit with a count of what was left out", () => {
  const memory = createMemoryService();
  for (let i = 0; i < 40; i += 1) memory.add(`${"Detail ".repeat(20)}${i}.`);
  const note = deliveredNote(memory, "a")!;
  assert.ok(note.length < 4600, String(note.length));
  assert.match(note, /older memories not shown/);
  assert.match(note, /Detail 39\./, "the newest is kept");
});

const botA = "bot_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const botB = "bot_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("notes and recall isolate Bots and groups while legacy memories stay global", async () => {
  const memory = createMemoryService();
  memory.add("Legacy shared preference.");
  memory.add("Explicit shared preference.", { kind: "global" });
  const privateA = memory.add("Bot A private preference.", { kind: "bot", id: botA });
  const privateB = memory.add("Bot B private preference.", { kind: "bot", id: botB });
  const groupA = memory.add("Group A shared preference.", { kind: "group", id: "room:a" });
  const groupB = memory.add("Group B shared preference.", { kind: "group", id: "room:b" });
  const context = { botId: botA, groupId: "room:a" };
  const note = memory.noteFor("chat", context)!;
  assert.match(note.text!, /Legacy shared preference/);
  assert.match(note.text!, /Explicit shared preference/);
  assert.match(note.text!, /Bot A private preference/);
  assert.match(note.text!, /Group A shared preference/);
  assert.doesNotMatch(note.text!, /Bot B|Group B/);
  note.delivered();
  assert.equal(memory.noteFor("chat", context), undefined);
  assert.match(memory.noteFor("chat", { botId: botB, groupId: "room:b" })!.text!, /Bot B private preference/,
    "another Bot's receipt in the same group conversation cannot suppress this context");

  const toolsA = memory.toolsFor({ conversationId: "chat", agent: "assistant", ...context })!;
  const recalled = JSON.parse((await toolsA.run("recall_memories", {})).text);
  assert.deepEqual(recalled.memories.map((item: Json) => item.text), ["Group A shared preference.", "Bot A private preference.", "Explicit shared preference.", "Legacy shared preference."]);
  assert.equal(recalled.total, 4);
  for (const inaccessible of [privateB, groupB]) {
    assert.deepEqual(await toolsA.run("forget", { id: inaccessible.id }), await toolsA.run("forget", { id: "missing" }),
      "forget does not reveal whether another owner has the id");
    assert.equal(memory.state().memories.some(item => item.id === inaccessible.id), true);
  }
  assert.equal((await toolsA.run("forget", { id: privateA.id })).isError, false);
  const toolsBInGroupA = memory.toolsFor({ conversationId: "other-chat", agent: "assistant", botId: botB, groupId: "room:a" })!;
  assert.equal((await toolsBInGroupA.run("forget", { id: groupA.id })).isError, false, "members can manage their shared group memories");
  const legacyNote = memory.noteFor("legacy")!.text!;
  assert.match(legacyNote, /Legacy shared preference/);
  assert.doesNotMatch(legacyNote, /Bot [AB]|Group [AB]/);
});

test("remember resolves owners from the run, deduplicates only within its scope, and retains Bot attribution", async () => {
  const memory = createMemoryService();
  const source = { conversationId: "chat-a", agent: "assistant" as const, botId: botA };
  const toolsA = memory.toolsFor(source)!;
  const savedA = JSON.parse((await toolsA.run("remember", { text: "Uses metric units." })).text);
  assert.deepEqual(savedA.scope, { kind: "bot", id: botA });
  assert.deepEqual(memory.state().memories[0].source, source);
  const duplicate = JSON.parse((await toolsA.run("remember", { text: "uses metric units." })).text);
  assert.equal(duplicate.id, savedA.id);
  const toolsB = memory.toolsFor({ conversationId: "chat-b", agent: "assistant", botId: botB })!;
  const savedB = JSON.parse((await toolsB.run("remember", { text: "Uses metric units." })).text);
  assert.notEqual(savedB.id, savedA.id, "the same sentence saved by another Bot must not return a private memory id");
  assert.deepEqual(savedB.scope, { kind: "bot", id: botB });
  const toolsGroup = memory.toolsFor({ ...source, groupId: "room:a" })!;
  assert.deepEqual(JSON.parse((await toolsGroup.run("remember", { text: "Uses metric units." })).text).scope, { kind: "group", id: "room:a" });
  assert.deepEqual(JSON.parse((await toolsGroup.run("remember", { text: "Personal preference.", scope: "bot" })).text).scope, { kind: "bot", id: botA });
  assert.deepEqual(JSON.parse((await toolsA.run("remember", { text: "Shared preference.", scope: "global" })).text).scope, { kind: "global" });
  for (const args of [{ text: "Unwanted.", scope: { kind: "bot", id: botB } }, { text: "Unwanted.", scope: "bot", botId: botB }, { text: "Unwanted.", scope: "group" }]) {
    assert.equal((await toolsA.run("remember", args)).isError, true);
  }
  assert.equal(memory.state().memories.some(item => item.text === "Unwanted."), false);
  assert.deepEqual(JSON.parse((await memory.toolsFor({ conversationId: "legacy", agent: "planner" })!.run("remember", { text: "Old caller." })).text).scope, { kind: "global" });
});

test("remember replaces a visible record atomically at capacity and clears stale evidence unless supplied", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-replace-"));
  try {
    let time = 1;
    const memory = createMemoryService({ dataDir, now: () => time });
    const source = { conversationId: "chat", agent: "assistant" as const, botId: botA, groupId: "room:a" };
    const tools = memory.toolsFor(source)!;
    const saved = JSON.parse((await tools.run("remember", { text: "The old supported feature.", scope: "bot" })).text);
    const old = memory.update(saved.id, saved.text, undefined, { url: "https://example.com/old", checkedAt: "2024-01-01" });
    for (let i = 0; i < 99; i += 1) memory.add(`Other fact ${i}.`);
    time = 2;
    const result = await tools.run("remember", { text: "The new supported feature.", replaceId: old.id, expectedText: old.text });
    assert.equal(result.isError, false);
    const replaced = memory.state().memories.find(item => item.id === old.id)!;
    assert.equal(replaced.text, "The new supported feature.");
    assert.equal(replaced.evidence, undefined, "old evidence cannot certify the replacement");
    assert.equal(replaced.createdAt, old.createdAt);
    assert.equal(replaced.updatedAt, 2);
    assert.deepEqual(replaced.scope, old.scope, "a group caller replacing its Bot memory keeps the Bot scope");
    assert.deepEqual(replaced.source, old.source);
    assert.equal(memory.state().memories.length, 100);
    const evidence = { url: "https://example.com/new", checkedAt: "2026-11-01" };
    const sourced = JSON.parse((await tools.run("remember", { text: "The verified replacement.", replaceId: old.id, expectedText: replaced.text, evidence })).text);
    assert.deepEqual(sourced.evidence, evidence);
    assert.equal(sourced.id, old.id);
    assert.deepEqual(createMemoryService({ dataDir }).state(), memory.state());
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("replacement rejects stale text, inaccessible records and invalid input without changing memories", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-replace-invalid-"));
  try {
    const memory = createMemoryService({ dataDir });
    const own = memory.add("Original Bot fact.", { kind: "bot", id: botA }, { url: "https://example.com/original" });
    const privateBot = memory.add("Private Bot fact.", { kind: "bot", id: botB });
    const privateGroup = memory.add("Private group fact.", { kind: "group", id: "room:b" });
    const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant", botId: botA, groupId: "room:a" })!;
    const original = memory.state();
    const persisted = readFileSync(join(dataDir, "memories.json"), "utf8");
    memory.noteFor("chat", { botId: botA, groupId: "room:a" })!.delivered();
    const missing = await tools.run("remember", { text: "Replacement.", replaceId: "missing", expectedText: "Unknown original." });
    assert.equal(missing.isError, true);
    for (const item of [privateBot, privateGroup]) {
      assert.deepEqual(await tools.run("remember", { text: "Replacement.", replaceId: item.id, expectedText: item.text }), missing);
    }
    for (const input of [
      { text: "Replacement.", replaceId: own.id }, { text: "Replacement.", expectedText: own.text },
      { text: "Replacement.", replaceId: own.id, expectedText: "Stale original." },
      { text: "Replacement.", replaceId: own.id, expectedText: own.text, scope: "global" },
      { text: "Replacement.", replaceId: own.id, expectedText: own.text, evidence: { url: "https://example.com", checkedAt: "2026-02-30" } },
      { text: "password: secret", replaceId: own.id, expectedText: own.text },
    ]) assert.equal((await tools.run("remember", input)).isError, true);
    assert.throws(() => memory.update(own.id, "Overwritten.", undefined, null, "Original Bot fact. "), /Memory changed/,
      "manual edits compare the exact captured text, without normalizing a stale draft");
    assert.throws(() => memory.update(own.id, "Overwritten.", undefined, null, null as never), /expectedText/);
    assert.deepEqual(memory.state(), original);
    assert.equal(readFileSync(join(dataDir, "memories.json"), "utf8"), persisted);
    assert.equal(memory.noteFor("chat", { botId: botA, groupId: "room:a" }), undefined, "failed replacement does not advance the version");
    memory.update(own.id, "Changed in Settings.");
    const stale = await tools.run("remember", { text: "Replacement.", replaceId: own.id, expectedText: own.text });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Memory changed/);
    assert.equal(memory.state().memories.find(item => item.id === own.id)?.text, "Changed in Settings.");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("failed replacement persistence leaves the prior memory available after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-replace-write-"));
  const displaced = `${dataDir}-saved`;
  try {
    const memory = createMemoryService({ dataDir });
    const saved = memory.add("Original fact.", undefined, { url: "https://example.com/original" });
    const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant" })!;
    renameSync(dataDir, displaced);
    writeFileSync(dataDir, "Blocks the memory directory.");
    const result = await tools.run("remember", { text: "Replacement.", replaceId: saved.id, expectedText: saved.text });
    assert.equal(result.isError, true);
    assert.deepEqual(memory.state().memories, [saved]);
    rmSync(dataDir);
    renameSync(displaced, dataDir);
    assert.deepEqual(createMemoryService({ dataDir }).state().memories, [saved]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  }
});

test("replacement rejects another record's text in the same scope but allows text from another scope", async () => {
  const memory = createMemoryService();
  const own = memory.add("Own original fact.", { kind: "bot", id: botA });
  memory.add("Another Bot A fact.", { kind: "bot", id: botA });
  const other = memory.add("Bot B fact.", { kind: "bot", id: botB });
  const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant", botId: botA })!;
  const original = memory.state();
  const collision = await tools.run("remember", { replaceId: own.id, expectedText: own.text, text: "  ANOTHER   BOT A FACT. " });
  assert.equal(collision.isError, true);
  assert.match(collision.text, /already has this text/);
  assert.deepEqual(memory.state(), original);
  assert.throws(() => memory.update(own.id, other.text, { kind: "bot", id: botB }), /already has this text/);
  assert.deepEqual(memory.state(), original);
  const allowed = await tools.run("remember", { replaceId: own.id, expectedText: own.text, text: other.text });
  assert.equal(allowed.isError, false);
  assert.equal(memory.state().memories.length, 3);
  const legacy = memory.add("Legacy global fact.");
  const global = memory.add("Different global fact.", { kind: "global" });
  assert.throws(() => memory.update(global.id, legacy.text), /already has this text/, "legacy and explicit global share the same effective scope");
});

test("recall retrieves older eligible memories with stable metadata and bounded read-only results", async () => {
  const memory = createMemoryService();
  const source = { conversationId: "chat-a", agent: "assistant" as const, botId: botA };
  const tools = memory.toolsFor(source)!;
  const old = JSON.parse((await tools.run("remember", { text: "Older searchable fact." })).text);
  for (let i = 0; i < 40; i += 1) memory.add(`${"Detail ".repeat(20)}${i}.`, { kind: "bot", id: botA });
  memory.add("Older searchable fact belongs to another Bot.", { kind: "bot", id: botB });
  const note = memory.noteFor(source.conversationId, source)!;
  assert.doesNotMatch(note.text!, /Older searchable fact/);
  assert.match(note.text!, /older memories not shown/);
  note.delivered();
  const recalled = JSON.parse((await tools.run("recall_memories", { query: "OLDER SEARCHABLE" })).text);
  assert.equal(recalled.total, 1);
  assert.equal(recalled.hasMore, false);
  assert.deepEqual(recalled.memories, [memory.state().memories.find(item => item.id === old.id)]);
  assert.deepEqual(recalled.memories[0].source, source);
  assert.equal(memory.noteFor(source.conversationId, source), undefined, "recall does not increment the saved version");
  const bounded = JSON.parse((await tools.run("recall_memories", { limit: 20 })).text);
  assert.equal(bounded.memories.length, 20);
  assert.equal(bounded.total, 41);
  assert.equal(bounded.hasMore, true);
  assert.equal(JSON.parse((await tools.run("recall_memories", {})).text).memories.length, 10);
  for (const input of [{ limit: 21 }, { limit: 0 }, { limit: 1.5 }, { query: "x".repeat(201) }]) assert.equal((await tools.run("recall_memories", input)).isError, true);
  memory.setEnabled(false);
  assert.equal(memory.toolsFor(source), undefined);
  for (const [name, args] of [["recall_memories", {}], ["remember", { text: "Disabled save." }], ["forget", { id: old.id }]] as const) {
    const result = await tools.run(name, args);
    assert.equal(result.isError, true, "tools captured before disabling also stop reading and writing");
    assert.match(result.text, /switched off/);
  }
});

test("recall cursors traverse every matching scoped memory once across bounded pages", async () => {
  const memory = createMemoryService({ now: () => 123 });
  const expected: string[] = [];
  for (let i = 0; i < 43; i += 1) {
    const scope = i % 3 === 0 ? { kind: "global" as const }
      : i % 3 === 1 ? { kind: "bot" as const, id: botA } : { kind: "group" as const, id: "room:a" };
    expected.unshift(memory.add(`Searchable fact ${i}.`, scope).id);
    if (i % 2 === 0) {
      memory.add(`Searchable private Bot fact ${i}.`, { kind: "bot", id: botB });
      memory.add(`Searchable private group fact ${i}.`, { kind: "group", id: "room:b" });
    }
  }
  memory.add("An unrelated visible fact.");
  const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant", botId: botA, groupId: "room:a" })!;
  memory.noteFor("chat", { botId: botA, groupId: "room:a" })!.delivered();
  const found: string[] = [];
  let cursor: string | undefined;
  for (const count of [20, 20, 3]) {
    const result = await tools.run("recall_memories", { query: "  SEARCHABLE   FACT  ", limit: 20, ...(cursor ? { cursor } : {}) });
    assert.equal(result.isError, false);
    const page = JSON.parse(result.text);
    assert.equal(page.memories.length, count);
    assert.equal(page.total, 43, "the total counts only eligible query matches");
    found.push(...page.memories.map((item: Json) => item.id as string));
    assert.equal(page.hasMore, found.length < 43);
    if (page.hasMore) assert.equal(typeof page.nextCursor, "string", "every incomplete page can be continued");
    else assert.equal(page.nextCursor, undefined);
    cursor = page.nextCursor;
  }
  assert.deepEqual(found, expected, "equal timestamps retain newest insertion first with no repeats or omissions");
  assert.equal(memory.noteFor("chat", { botId: botA, groupId: "room:a" }), undefined, "paging is read-only");
});

test("editing an old memory brings it into the bounded note and first recall page", async () => {
  let time = 1;
  const memory = createMemoryService({ now: () => time });
  const old = memory.add("The old preference.");
  for (let i = 0; i < 40; i += 1) {
    time += 1;
    memory.add(`${"Detailed preference ".repeat(10)}${i}.`);
  }
  assert.doesNotMatch(deliveredNote(memory, "chat")!, /The old preference/);
  time += 1;
  memory.update(old.id, "The revised preference.");
  const note = deliveredNote(memory, "chat")!;
  assert.match(note, /updated[^\n]*\n- \([^\n]+\) The revised preference\./);
  assert.ok(note.length < 4600);
  assert.match(note, /older memories not shown/);
  const tools = memory.toolsFor({ conversationId: "chat", agent: "assistant" })!;
  const first = JSON.parse((await tools.run("recall_memories", { limit: 1 })).text);
  assert.equal(first.memories[0].id, old.id);
});

test("recall rejects malformed, stale and mismatched cursors without revealing scoped results", async () => {
  const memory = createMemoryService();
  for (let i = 0; i < 25; i += 1) memory.add(`Shared fact ${i}.`);
  const privateMemory = memory.add("Private Bot fact.", { kind: "bot", id: botB });
  const source = { conversationId: "chat", agent: "assistant" as const, botId: botA, groupId: "room:a" };
  const tools = memory.toolsFor(source)!;
  const cursor = JSON.parse((await tools.run("recall_memories", { query: "fact", limit: 20 })).text).nextCursor as string;
  const invalid = await tools.run("recall_memories", { query: "fact", cursor: "invalid" });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /cursor/);
  for (const value of [null, false, 1, {}, [], "", "x".repeat(65), `${cursor}x`, cursor.replace(/^\d+/, "0"), cursor.replace(/^\d+/, "100"), cursor.replace(/^\d+/, "1")]) {
    assert.deepEqual(await tools.run("recall_memories", { query: "fact", cursor: value }), invalid);
  }
  for (const query of [undefined, "Shared fact", "no results"]) {
    assert.deepEqual(await tools.run("recall_memories", { query, cursor }), invalid, "a cursor cannot change its query even if matches overlap");
  }
  for (const context of [{ botId: botB, groupId: "room:a" }, { botId: botA, groupId: "room:b" }, {}]) {
    const other = memory.toolsFor({ conversationId: "other", agent: "assistant", ...context })!;
    assert.deepEqual(await other.run("recall_memories", { query: "fact", cursor }), invalid,
      "another scope receives the same error as a malformed cursor, with no totals or memory data");
  }
  const continuation = JSON.parse((await tools.run("recall_memories", { query: " FACT ", cursor, limit: 3 })).text);
  assert.equal(continuation.memories.length, 3, "normalized queries and a changed page size can continue");
  assert.equal(continuation.hasMore, true);
  for (const change of [
    () => memory.update(privateMemory.id, "Changed private Bot fact."),
    () => memory.add("New shared fact."),
    () => memory.remove(privateMemory.id),
    () => { memory.setEnabled(false); memory.setEnabled(true); },
  ]) {
    const current = JSON.parse((await tools.run("recall_memories", { query: "fact", limit: 20 })).text).nextCursor;
    change();
    assert.deepEqual(await tools.run("recall_memories", { query: "fact", cursor: current }), invalid,
      "any saved version change expires a cursor instead of skipping or repeating results");
  }
});

test("same-timestamp memory order and cursors survive a host restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-cursor-"));
  try {
    let time = 123;
    const memory = createMemoryService({ dataDir, now: () => time });
    const ids = ["First fact.", "Second fact.", "Third fact.", "Fourth fact."].map(text => memory.add(text).id);
    time = 122;
    memory.update(ids[0], "Edited first fact.");
    const source = { conversationId: "chat", agent: "assistant" as const, botId: botA };
    const first = JSON.parse((await memory.toolsFor(source)!.run("recall_memories", { limit: 2 })).text);
    assert.deepEqual(first.memories.map((item: Json) => item.id), [ids[0], ids[3]], "an edit stays newest when the clock repeats or moves backwards");
    const restored = createMemoryService({ dataDir });
    const next = JSON.parse((await restored.toolsFor(source)!.run("recall_memories", { limit: 2, cursor: first.nextCursor })).text);
    assert.deepEqual(next.memories.map((item: Json) => item.id), [ids[2], ids[1]]);
    assert.equal(next.hasMore, false);
    assert.equal(next.nextCursor, undefined);
    assert.match(restored.noteFor("chat")!.text!, /Edited first fact[\s\S]*Fourth fact[\s\S]*Third fact[\s\S]*Second fact/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("scoped delivery receipts acknowledge only their captured version and context", async () => {
  const memory = createMemoryService();
  memory.add("Shared first fact.");
  const context = { botId: botA, groupId: "room:a" };
  const first = memory.noteFor("chat", context)!;
  const other = memory.noteFor("chat", { botId: botB, groupId: "room:a" })!;
  memory.add("Later scoped fact.", { kind: "group", id: "room:a" });
  first.delivered();
  const next = memory.noteFor("chat", context)!;
  assert.match(next.text!, /updated[\s\S]*Later scoped fact/);
  next.delivered();
  first.delivered();
  assert.equal(memory.noteFor("chat", context), undefined);
  other.delivered();
  assert.match(memory.noteFor("chat", { botId: botB, groupId: "room:a" })!.text!, /Later scoped fact/);
  await memory.toolsFor({ conversationId: "chat", agent: "assistant", ...context })!.run("remember", { text: "Known in this run." });
  assert.equal(memory.noteFor("chat", context), undefined, "a caller already current does not replay its own save");
});

test("invalidating a memory receipt refreshes only its conversation and scope despite late acknowledgements", async () => {
  const memory = createMemoryService();
  memory.add("Shared saved fact.");
  const context = { botId: botA, groupId: "room:a" };
  const otherContext = { botId: botB, groupId: "room:a" };
  const first = memory.noteFor("chat", context)!;
  first.delivered();
  memory.noteFor("chat", otherContext)!.delivered();
  memory.noteFor("other-chat", context)!.delivered();
  memory.invalidate("chat", context);
  first.delivered();
  const pending = memory.noteFor("chat", context)!;
  assert.match(pending.text!, /Shared saved fact/);
  assert.equal(memory.noteFor("chat", otherContext), undefined);
  assert.equal(memory.noteFor("other-chat", context), undefined);
  memory.invalidate("chat", context);
  pending.delivered();
  assert.match(memory.noteFor("chat", context)!.text!, /Shared saved fact/,
    "a callback prepared before the latest invalidation cannot consume its refresh");
  await memory.toolsFor({ conversationId: "chat", agent: "assistant", ...context })!.run("remember", { text: "New saved fact." });
  const refresh = memory.noteFor("chat", context)!;
  assert.match(refresh.text!, /New saved fact[\s\S]*Shared saved fact/, "a local save does not settle an invalidated receipt");
  refresh.delivered();
  first.delivered();
  pending.delivered();
  assert.equal(memory.noteFor("chat", context), undefined, "the accepted refresh is delivered only once");
});

test("a conversation reset invalidates all of its memory contexts while explicit empty scope stays exact", () => {
  const memory = createMemoryService();
  memory.add("Shared saved fact.");
  const contexts = [{}, { botId: botA }, { botId: botB, groupId: "room:a" }];
  const receipts = contexts.map(context => memory.noteFor("chat", context)!);
  for (const receipt of receipts) receipt.delivered();
  memory.noteFor("another-chat", contexts[2])!.delivered();
  memory.invalidate("chat", {});
  const legacy = memory.noteFor("chat")!;
  assert.match(legacy.text!, /Shared saved fact/);
  assert.equal(memory.noteFor("chat", contexts[1]), undefined);
  assert.equal(memory.noteFor("chat", contexts[2]), undefined);
  legacy.delivered();
  memory.invalidate("chat");
  for (const receipt of [...receipts, legacy]) receipt.delivered();
  for (const context of contexts) {
    const refresh = memory.noteFor("chat", context)!;
    assert.match(refresh.text!, /Shared saved fact/);
    refresh.delivered();
    assert.equal(memory.noteFor("chat", context), undefined);
  }
  assert.equal(memory.noteFor("another-chat", contexts[2]), undefined);
});

test("invalidating memory preserves cleared and disabled notices and unseen delivery semantics", () => {
  for (const disable of [false, true]) {
    const memory = createMemoryService();
    const saved = memory.add("Saved fact.");
    const pending = memory.noteFor("chat")!;
    memory.invalidate("chat");
    pending.delivered();
    const initial = memory.noteFor("chat")!;
    assert.match(initial.text!, /Saved fact/);
    assert.doesNotMatch(initial.text!, /updated:/, "a rejected old receipt does not make an unseen note delivered");
    initial.delivered();
    if (disable) memory.setEnabled(false); else memory.remove(saved.id);
    const cleared = memory.noteFor("chat")!;
    cleared.delivered();
    memory.invalidate("chat");
    cleared.delivered();
    const reminder = memory.noteFor("chat")!;
    assert.match(reminder.text!, /cleared or switched off/);
    reminder.delivered();
    assert.equal(memory.noteFor("chat"), undefined);
    memory.invalidate("never-seen");
    assert.equal(memory.noteFor("never-seen")!.text, undefined, "invalidation does not invent previously delivered memories");
  }
});

test("scope persistence preserves legacy global entries and text-only edits; malformed files fail closed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-scope-"));
  const file = join(dataDir, "memories.json");
  const legacy = { id: "mlegacy", text: "Legacy preference.", createdAt: 1, updatedAt: 1, source: { conversationId: "old-chat", agent: "planner" } };
  try {
    writeFileSync(file, JSON.stringify({ enabled: true, version: 1, memories: [legacy] }));
    const memory = createMemoryService({ dataDir });
    assert.deepEqual(memory.state().memories, [legacy]);
    assert.match(memory.noteFor("new-chat", { botId: botA })!.text!, /Legacy preference/);
    memory.update(legacy.id, "Updated legacy preference.");
    assert.equal(memory.state().memories[0].scope, undefined);
    const own = memory.add("Scoped fact.", { kind: "bot", id: botA });
    assert.deepEqual(memory.update(own.id, "Edited scoped fact.").scope, own.scope);
    assert.deepEqual(createMemoryService({ dataDir }).state().memories[1].scope, own.scope);
    assert.deepEqual(memory.update(own.id, "Shared now.", { kind: "global" }).scope, { kind: "global" });
    for (const scope of [{ kind: "unknown" }, { kind: "bot", id: "other" }, { kind: "group", id: "../bad" }, { kind: "global", id: botA }]) {
      assert.throws(() => memory.add("Invalid scope.", scope as never), /Invalid memory scope/);
      assert.throws(() => memory.update(own.id, "Invalid scope.", scope as never), /Invalid memory scope/);
    }
    const malformed = [
      [{ ...legacy, scope: { kind: "bot", id: "wrong" } }],
      [{ ...legacy, scope: { kind: "group", id: "../bad" } }],
      [{ ...legacy, scope: { kind: "global", id: "unexpected" } }],
      [{ ...legacy, scope: { kind: "unknown" } }],
      [{ ...legacy, source: { ...legacy.source, botId: "wrong" } }],
      [{ ...legacy, evidence: null }],
      [{ ...legacy, evidence: { url: "https://example.com", checkedAt: "2025-02-29" } }],
      [{ ...legacy, evidence: { url: "https://user:secret@example.com" } }],
      [{ ...legacy, id: "../invalid" }],
      [legacy, legacy],
      Array.from({ length: 101 }, (_, i) => ({ ...legacy, id: `m${i}` })),
    ];
    for (const memories of malformed) {
      const original = JSON.stringify({ enabled: true, version: 2, memories });
      writeFileSync(file, original);
      const unreadable = createMemoryService({ dataDir });
      assert.equal(unreadable.enabled, false);
      assert.equal(unreadable.noteFor("chat"), undefined);
      assert.equal(unreadable.toolsFor({ conversationId: "chat", agent: "assistant" }), undefined);
      assert.throws(() => unreadable.state(), /could not be read/);
      assert.throws(() => unreadable.add("Do not replace."), /could not be read/);
      assert.equal(readFileSync(file, "utf8"), original);
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("remember and forget ask like connector calls, through every engine's host-tool channel", async () => {
  const policy = { cwd: "/workspace", protectedPaths: [] };
  assert.equal(classifyToolCall("remember", { text: "x" }, policy), "connector");
  assert.equal(classifyToolCall("forget", { id: "m1" }, policy), "connector");
  assert.equal(normalizeClaudeTool("mcp__raytone__remember", { text: "x" }).name, "remember");

  const hostTools = { specs: MEMORY_TOOL_SPECS, async run() { return { text: "{\"saved\":true}", isError: false }; } };
  const args = buildClaudeArgs({ permissionMode: "request", hostTools });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { raytone: { type: "sdk", name: "raytone" } } },
    "the host's own server carries memory tools even without web tools");

  const sent: Json[] = [], asked: string[] = [];
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "remember", signal: new AbortController().signal, hostTools,
    emit() {}, onSessionId() {}, async onPermission(request) { asked.push(request.tool.name); return true; } });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "initialize", result: {} });
  assert.deepEqual(((sent[1].params as Json).dynamicTools as Json[]).map((tool) => tool.name), ["remember", "forget", "recall_memories"]);
  push({ id: "thread", result: { thread: { id: "t" } } });
  push({ id: 7, method: "item/tool/call", params: { threadId: "t", callId: "c7", tool: "remember", arguments: { text: "Prefers tea." } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["remember"]);
  assert.deepEqual(sent.at(-1), { id: 7, result: { contentItems: [{ type: "inputText", text: "{\"saved\":true}" }], success: true } });
});

test("the host adds the memory note to the model's copy of the prompt and serves the settings routes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-memory-host-"));
  const prompts: string[] = [];
  const factory: PiBridgeFactory = async () => {
    let emit: Parameters<Awaited<ReturnType<PiBridgeFactory>>["subscribe"]>[0] = () => {};
    return {
      subscribe(fn) { emit = fn; return () => {}; },
      async prompt(prompt) {
        prompts.push(prompt);
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      },
      async abort() {}, dispose() {}, async configure() {}, async newSession() {},
      async state() { return { models: [], tools: [] }; },
    };
  };
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: factory, routineClock: false });
  const server: Server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/memories`;
  const authFetch = await authenticatedFetch(host, base);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await authFetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  };
  try {
    assert.deepEqual((await call("")).body, { enabled: true, memories: [] });
    const evidence = { url: "https://example.com/preferences", checkedAt: "2026-11-01" };
    const added = await call("", "POST", { text: "Prefers short answers.", evidence });
    assert.equal(added.status, 201);
    assert.deepEqual((added.body.memory as Json).evidence, evidence);
    assert.equal((await call("", "POST", { text: "sk-abcdefghijklmnopqrstuvwxyz" })).status, 400);
    await host.controller.runPrompt({ conversationId: "chat", prompt: "你好" }, () => {});
    await host.controller.runPrompt({ conversationId: "chat", prompt: "再来" }, () => {});
    assert.match(prompts[0], /^你好[\s\S]*\[Memory from RaytoneBot[\s\S]*Prefers short answers\./);
    assert.doesNotMatch(prompts[1], /Memory from RaytoneBot/);
    assert.equal(host.controller.getConversation("chat")?.events.some((event) => JSON.stringify(event).includes("Memory from RaytoneBot")), false,
      "the transcript keeps what the user typed");

    const id = (added.body.memory as Json).id as string;
    assert.equal((await call(`/${id}`, "POST", { text: "Should not overwrite.", expectedText: "Stale original." })).status, 409);
    assert.equal((await call(`/${id}`, "POST", { text: "Prefers short answers in Chinese.", expectedText: "Prefers short answers." })).status, 200);
    const captured = (await call("")).body.memories as Json[];
    const prior = captured.find(item => item.id === id)!;
    const priorSnapshot = { text: prior.text, scope: prior.scope ?? { kind: "global" }, evidence: prior.evidence ?? null };
    const changedEvidence = { url: "https://example.com/preferences-v2", checkedAt: "2026-11-02" };
    assert.equal((await call(`/${id}`, "POST", { text: prior.text, evidence: changedEvidence, expectedText: prior.text })).status, 200);
    const beforeConflict = (await call("")).body.memories as Json[];
    const staleResponse = await call(`/${id}`, "POST", { text: "Overwritten from stale editor.", expectedText: prior.text, expectedSnapshot: priorSnapshot });
    assert.equal(staleResponse.status, 409);
    assert.match(String(staleResponse.body.error), /changed/i);
    assert.deepEqual((await call("")).body.memories, beforeConflict, "stale metadata snapshots cannot alter the record through HTTP");
    const malformed = await call(`/${id}`, "POST", { text: "Rejected malformed snapshot.", expectedSnapshot: { text: prior.text, scope: { kind: "global" } } });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await call("")).body.memories, beforeConflict, "malformed snapshots are rejected without writing");
    await host.controller.runPrompt({ conversationId: "chat", prompt: "第三轮" }, () => {});
    assert.match(prompts[2], /updated[\s\S]*in Chinese/);
    const clearedEvidence = await call(`/${id}`, "POST", { text: "Prefers short answers in Chinese.", evidence: null, expectedText: "Prefers short answers in Chinese." });
    assert.equal(clearedEvidence.status, 200);
    assert.equal((clearedEvidence.body.memory as Json).evidence, undefined);
    assert.equal((await call(`/${id}`, "POST", { text: "Should not overwrite.", evidence: { url: "https://example.com", checkedAt: "2025-02-29" } })).status, 400);
    assert.equal((await call("/settings", "POST", { enabled: false })).body.enabled, false);
    assert.equal((await call(`/${id}`, "DELETE")).status, 200);
    assert.equal((await call(`/${id}`, "DELETE")).status, 404);
  } finally {
    host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
