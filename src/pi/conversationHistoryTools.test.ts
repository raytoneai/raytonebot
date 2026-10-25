import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";

import { CHAT_HISTORY_OUTPUT_LIMIT, createConversationHistoryTools } from "./conversationHistoryTools.ts";
import { createConversationStore } from "./conversationStore.ts";
import { matchConversationText } from "./conversationSearch.ts";
import type { HostTools } from "./memories.ts";

function message(runId: string, textId: string, role: string, text: string, ts = 1): AgentUXEvent[] {
  return [
    { type: "text.started", runId, ts, payload: { textId, role } },
    { type: "text.delta", runId, payload: { textId, delta: text } },
    { type: "text.finished", runId, payload: { textId } },
  ];
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "raytone-history-"));
  const store = createConversationStore(dir);
  const add = (id: string, events: AgentUXEvent[]) => {
    store.begin(id, "assistant", "Visible conversation");
    for (const event of events) store.append(id, event);
  };
  return { store, add, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function success(tools: HostTools, name: string, args: unknown) {
  const result = await tools.run(name, args);
  assert.equal(result.isError, false, result.text);
  assert.ok(result.text.length <= CHAT_HISTORY_OUTPUT_LIMIT);
  return JSON.parse(result.text);
}

test("history tools expose only public user/assistant text and read live chunks with stable anchors", async () => {
  const f = fixture();
  try {
    const events = [
      ...message("r1", "user", "user", "Find Café [a].*", 10),
      { type: "text.started", runId: "r1", ts: 11, payload: { textId: "answer", role: "assistant" } },
      { type: "text.delta", runId: "r1", payload: { textId: "answer", delta: "streamed " } },
      { type: "text.started", runId: "r1", ts: 999, payload: { textId: "answer", role: "assistant" } },
      { type: "text.delta", runId: "r1", payload: { textId: "answer", delta: "answer" } },
      ...message("r1", "system", "system", "hidden system secret"),
      ...message("r1", "hidden", "assistant", "hidden visibility secret").map(event => ({ ...event, visibility: "hidden" as const })),
      ...message("r1", "debug", "assistant", "hidden debug secret").map(event => ({ ...event, visibility: "debug" as const })),
      ...message("r1", "developer", "user", "hidden developer secret").map(event => ({ ...event, visibility: "developer" as const })),
      { type: "text.delta", runId: "r1", payload: { textId: "answer", delta: "hidden delta secret" }, visibility: "hidden" as const },
      { type: "text.started", runId: "r1", payload: { textId: "skipped", role: "user" } },
      { type: "text.delta", runId: "r1", payload: { textId: "skipped", delta: "hidden skipped secret", inputSkipped: true } },
      { type: "text.delta", runId: "r1", payload: { textId: "orphan", delta: "hidden orphan secret" } },
      { type: "reasoning.delta", runId: "r1", payload: { textId: "answer", delta: "hidden reasoning secret" } },
      { type: "tool.call.result", runId: "r1", payload: { textId: "answer", delta: "hidden tool secret", credentials: { password: "private" } } },
    ];
    f.add("current", events);
    f.store.setExtra("current", { cliSession: { harness: "claude", id: "hidden native secret" }, documents: [], privateCredentials: "hidden credential secret" });
    const tools = createConversationHistoryTools({ store: f.store, conversationId: "current" });
    assert.deepEqual(tools.specs.map(spec => spec.name), ["search_chat_history", "read_chat_history"]);
    assert.deepEqual((await success(tools, "search_chat_history", { query: "hidden" })).messages, []);
    assert.equal(matchConversationText("title", events, "hidden"), undefined, "sidebar search shares the public-text boundary");
    const unicode = await success(tools, "search_chat_history", { query: "cafe\u0301 [a].*" });
    assert.deepEqual(unicode.messages, [{ conversationId: "current", runId: "r1", textId: "user", role: "user", timestamp: 10, snippet: "Find Café [a].*", truncated: false }]);
    const live = await success(tools, "read_chat_history", { textId: "answer", before: 0, after: 0 });
    assert.equal(live.messages[0].text, "streamed answer");
    assert.equal(live.messages[0].timestamp, 11, "duplicate starts do not erase live chunks or replace timestamps");
    f.store.append("current", { type: "text.delta", runId: "r1", payload: { textId: "answer", delta: " continues" } });
    assert.equal((await success(tools, "search_chat_history", { query: "answer continues" })).messages[0].textId, "answer");
  } finally { f.cleanup(); }
});

test("history scope is host-owned, defaults to current chat, and never exposes hidden group children", async () => {
  const f = fixture();
  try {
    for (const id of ["current", "referenced", "other", "room", "room.m.assistant"]) f.add(id, message("run", "text", "user", `${id} needle`));
    const allow = ["referenced", "room", "room.m.assistant"];
    const tools = createConversationHistoryTools({ store: f.store, conversationId: "current", allowedConversationIds: allow });
    allow.push("other");
    assert.equal((await success(tools, "search_chat_history", { query: "needle" })).messages[0].conversationId, "current");
    assert.equal((await success(tools, "search_chat_history", { query: "needle", conversationId: "referenced" })).messages[0].conversationId, "referenced");
    assert.equal((await success(tools, "read_chat_history", { textId: "text", conversationId: "referenced" })).messages[0].text, "referenced needle");
    for (const id of ["other", "room.m.assistant", "unknown", "../../private"]) {
      assert.match((await tools.run("search_chat_history", { query: "needle", conversationId: id })).text, /outside the history scope/);
      assert.equal((await tools.run("read_chat_history", { textId: "text", conversationId: id })).isError, true);
    }
    assert.equal((await tools.run("search_chat_history", { query: "needle", allowedConversationIds: ["other"] })).isError, true);
    const child = createConversationHistoryTools({ store: f.store, conversationId: "room" });
    assert.equal((await success(child, "search_chat_history", { query: "needle" })).messages[0].conversationId, "room", "host binds group members to the visible parent");
    const unreferenced = createConversationHistoryTools({ store: f.store, conversationId: "current" });
    assert.equal((await unreferenced.run("search_chat_history", { query: "needle", conversationId: "referenced" })).isError, true);
  } finally { f.cleanup(); }
});

test("read around returns accurate neighbors and disambiguates textIds reused across runs", async () => {
  const f = fixture();
  try {
    f.add("current", [
      ...message("a", "same", "user", "first", 1), ...message("a", "reply", "assistant", "second", 2),
      ...message("b", "same", "user", "third", 3), ...message("b", "reply", "assistant", "fourth", 4),
      ...message("c", "last", "user", "fifth", 5),
    ]);
    const tools = createConversationHistoryTools({ store: f.store, conversationId: "current" });
    const result = await success(tools, "read_chat_history", { textId: "same", runId: "b", before: 1, after: 1 });
    assert.deepEqual(result.messages.map((row: any) => [row.runId, row.textId, row.text]), [["a", "reply", "second"], ["b", "same", "third"], ["b", "reply", "fourth"]]);
    assert.equal(result.targetRunId, "b");
    assert.equal(result.hasEarlierMessages, true);
    assert.equal(result.hasLaterMessages, true);
    assert.equal(result.truncated, false);
    assert.match((await tools.run("read_chat_history", { textId: "same" })).text, /ambiguous.*runId/);
    assert.match((await tools.run("read_chat_history", { textId: "same", runId: "wrong" })).text, /missing/);
    assert.deepEqual((await success(tools, "search_chat_history", { query: "third" })).messages.map((row: any) => [row.runId, row.textId]), [["b", "same"]]);
    assert.equal((await success(tools, "read_chat_history", { textId: "last", before: 10, after: 0 })).messages.length, 5);
    assert.equal((await tools.run("read_chat_history", { textId: "last", before: 6, after: 5 })).isError, true);
  } finally { f.cleanup(); }
});

test("deleted, corrupt and missing histories and message anchors produce explicit errors without raw data", async () => {
  const f = fixture();
  try {
    f.add("current", message("run", "text", "assistant", "saved"));
    const tools = createConversationHistoryTools({ store: f.store, conversationId: "current", allowedConversationIds: ["broken"] });
    assert.match((await tools.run("read_chat_history", { textId: "gone" })).text, /Message anchor is missing/);
    f.store.remove("current");
    const deleted = await tools.run("search_chat_history", { query: "saved" });
    assert.equal(deleted.isError, true);
    assert.match(deleted.text, /missing or has been deleted/);
    writeFileSync(join(f.store.dir, "broken.json"), '{"secret": "DO_NOT_EXPOSE",');
    const broken = await tools.run("search_chat_history", { query: "saved", conversationId: "broken" });
    assert.equal(broken.isError, true);
    assert.match(broken.text, /could not be read/);
    assert.doesNotMatch(broken.text, /DO_NOT_EXPOSE/);
  } finally { f.cleanup(); }
});

test("history output bounds apply to snippets, escaped text and neighbor count with explicit truncation", async () => {
  const f = fixture();
  try {
    f.add("current", Array.from({ length: 30 }, (_, index) => message(`run${index}`, `text${index}`, "assistant", `${"prefix ".repeat(100)}needle ${"\u0000\n\"\\".repeat(10_000)}`, index)).flat());
    const tools = createConversationHistoryTools({ store: f.store, conversationId: "current" });
    const search = await success(tools, "search_chat_history", { query: "needle", limit: 20 });
    assert.equal(search.messages.length, 20);
    assert.equal(search.messages[0].textId, "text29");
    assert.equal(search.hasMore, true);
    assert.equal(search.truncated, true);
    assert.ok(search.messages.every((row: any) => row.truncated && row.snippet.length < 200));
    const read = await success(tools, "read_chat_history", { textId: "text15", before: 5, after: 5 });
    assert.equal(read.messages.length, 11);
    assert.equal(read.messages[5].textId, "text15");
    assert.equal(read.truncated, true);
    assert.ok(read.messages.every((row: any) => row.truncated));
    assert.equal((await tools.run("search_chat_history", { query: "needle", limit: 21 })).isError, true);
    assert.equal((await tools.run("search_chat_history", { query: "x".repeat(201) })).isError, true);
    assert.equal((await tools.run("read_chat_history", { textId: "text15", after: -1 })).isError, true);
  } finally { f.cleanup(); }
});

test("history tools preserve credential redaction and cancellation without reading unrelated records", async () => {
  const f = fixture();
  try {
    const token = `123456789:${"x".repeat(35)}`;
    f.add("current", message("run", "text", "user", `legacy token ${token}`));
    let reads = 0;
    const tools = createConversationHistoryTools({ store: { get(id) { reads++; return f.store.get(id); } }, conversationId: "current" });
    const result = await success(tools, "read_chat_history", { textId: "text" });
    assert.match(result.messages[0].text, /redacted Telegram bot token/);
    assert.doesNotMatch(result.messages[0].text, new RegExp(token));
    assert.deepEqual((await success(tools, "search_chat_history", { query: token })).messages, []);
    const before = reads;
    assert.equal((await tools.run("search_chat_history", { query: "legacy", conversationId: "unrelated" })).isError, true);
    assert.equal((await tools.run("search_chat_history", { query: "legacy" }, AbortSignal.abort())).isError, true);
    assert.equal(reads, before);
  } finally { f.cleanup(); }
});
