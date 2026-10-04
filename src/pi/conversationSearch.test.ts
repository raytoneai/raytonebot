import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createConversationStore } from "./conversationStore.ts";
import { matchConversationText } from "./conversationSearch.ts";
import { conversationSearchPage } from "./conversationSearchPage.ts";
import { createPiHttpHost } from "./piHost.ts";
import { searchStoredConversations } from "./piClient.ts";

function transcript(runId: string, prompt: string, chunks: string[]) {
  const adapter = createPiEventAdapter({ runId });
  adapter.startUserMessage(prompt);
  adapter.apply({ type: "message_start", message: { role: "assistant" } });
  for (const delta of chunks) adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  adapter.finish("success");
  return adapter.events;
}

test("message search joins streamed chunks, uses literal Unicode text, and never joins separate turns or searches tools", () => {
  const events = [...transcript("first", "最初的问题", ["前文 ".repeat(100), "跨分", "块 Café\n[abc].*", " 后文".repeat(100)]),
    ...transcript("second", "后续用户消息", ["另一个答案"])];
  assert.match(matchConversationText("标题", events, "跨分块 cafe\u0301 [abc].*")?.snippet ?? "", /跨分块 Café \[abc\]\.\*/);
  assert.ok(matchConversationText("标题", events, "后续用户消息"));
  assert.equal(matchConversationText("标题", events, "跨分块")?.textId, "first_m1_text_0");
  assert.equal(matchConversationText("标题", events, "后续用户消息")?.textId, "second_user_text");
  assert.equal(matchConversationText("标题", events, "最初的问题 前文"), undefined);
  assert.equal(matchConversationText("标题", events, "[a-z]+"), undefined);
  assert.ok((matchConversationText("标题", events, "Café")?.snippet?.length ?? 1000) < 150);
  const hidden = [{ type: "tool.call.result", runId: "r", payload: { textId: "hidden", delta: "private argument" } },
    { type: "text.delta", runId: "r", payload: { textId: "orphan", delta: "private argument" } }];
  assert.equal(matchConversationText("标题", hidden as never, "private"), undefined);
});

test("HTTP search returns cold history and branch prefixes without full transcripts, reports unreadable records, and rejects oversized queries", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-search-")), store = createConversationStore(dataDir);
  store.begin("source", "assistant", "相同的标题");
  for (const [runId, text] of [["first", "保留口令"], ["second", "后续口令"]]) {
    store.saveTurn("source", { runId, harness: "pi", prompt: text });
    store.saveNativeTurn("source", runId, { harness: "pi", sessionId: "native", sourceId: "source", beforeEntryId: runId });
    for (const event of transcript(runId, text, ["回复 ", text])) store.append("source", event);
  }
  store.flush("source"); store.branch("child", "source", "second");
  writeFileSync(join(store.dir, "broken.json"), '{"events":');
  const original = readFileSync(join(store.dir, "source.json"), "utf8");
  const host = createPiHttpHost({ cwd: dataDir, dataDir, bridgeFactory: async () => { throw new Error("Search must not start a model"); } });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/conversations`;
  try {
    const search = async (query: string) => (await fetch(`${base}?${new URLSearchParams({ query })}`)).json();
    const first = await search("保留口令");
    assert.deepEqual(first.conversations.map((c: { id: string }) => c.id).sort(), ["child", "source"]);
    assert.deepEqual(first.unreadable, ["broken"]);
    assert.ok(first.conversations.every((c: any) => c.snippet && !c.events && !c.turns && !c.piSessionId));
    assert.ok(first.conversations.every((c: any) => c.matches.length === 2), "user and assistant matches survive in source and branch");
    assert.equal((await search("口令")).conversations.find((c: any) => c.id === "source").matches.length, 4);
    const pageUrl = `${base}?query=${encodeURIComponent("口令")}&limit=2`;
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await fetch(pageUrl + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      assert.equal(response.status, 200);
      const page = await response.json();
      const hits = page.conversations.flatMap((c: any) => c.matches.map((m: any) => `${c.id}/${m.textId}`));
      assert.ok(hits.length <= 2, "pages bound messages, including multiple hits in one conversation");
      found.push(...hits); cursor = page.nextCursor;
      assert.ok(found.length <= 6, "pagination must advance");
    } while (cursor);
    assert.equal(found.length, 6);
    assert.equal(new Set(found).size, 6, "no gaps or repeats at conversation boundaries");
    for (const suffix of ["&limit=0", "&limit=101", "&limit=1.5", "&limit=2&cursor=garbage"]) {
      assert.equal((await fetch(`${base}?query=test${suffix}`)).status, 400);
    }
    assert.deepEqual((await search("后续口令")).conversations.map((c: { id: string }) => c.id), ["source"]);
    assert.equal((await search("不存在")).conversations.length, 0);
    assert.equal((await fetch(`${base}?query=${"x".repeat(201)}`)).status, 400);
    const ordinaryList = await (await fetch(base)).json();
    assert.equal(ordinaryList.conversations.length, 2);
    assert.ok(ordinaryList.conversations.every((c: any) => !c.matches && !c.snippet), "normal sidebar remains metadata-only");
    assert.equal(readFileSync(join(store.dir, "source.json"), "utf8"), original);
    assert.equal(host.controller.health().activeRuns, 0);
  } finally { host.dispose(); await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); }
});

test("search client encodes literal queries and forwards cancellation", async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  await searchStoredConversations("中文 & [.*]", controller.signal, async (url, init) => {
    assert.equal(new URL(String(url), "http://local").searchParams.get("query"), "中文 & [.*]");
    assert.equal(new URL(String(url), "http://local").searchParams.get("limit"), "100");
    assert.equal(init?.method ?? "GET", "GET"); received = init?.signal;
    return Response.json({ conversations: [], unreadable: [] });
  });
  assert.ok(received); controller.abort(); assert.equal(received.aborted, true);
});

test("seek pages retain remaining messages after newer inserts or deletion, and reject cursors for another query", () => {
  const summary = { id: "source", title: "title", createdAt: 1, updatedAt: 1, eventCount: 10, agentPreset: "assistant" as const,
    matches: [30, 20, 10].map(timestamp => ({ timestamp, textId: String(timestamp), snippet: "hit", role: "user" as const })) };
  const first = conversationSearchPage([summary], "hit", 1);
  assert.equal(first.conversations[0].matches?.[0].textId, "30");
  const changed = { ...summary, matches: [{ ...summary.matches[0], timestamp: 40, textId: "40" }, ...summary.matches.slice(1)] };
  const rest = conversationSearchPage([changed], "hit", 2, first.nextCursor);
  assert.deepEqual(rest.conversations[0].matches?.map(m => m.textId), ["20", "10"]);
  assert.equal(rest.nextCursor, undefined);
  assert.throws(() => conversationSearchPage([summary], "different", 1, first.nextCursor), /cursor is invalid/);
  const title = conversationSearchPage([{ ...summary, matches: undefined }], "title", 1);
  assert.equal(title.conversations[0].matches, undefined);
  assert.equal(title.nextCursor, undefined);
});

test("repeated text remains independently addressable across messages and turns", () => {
  const events = [...transcript("one", "共同词 用户一", ["共同词 助手一 共同词"]),
    ...transcript("two", "共同词 用户二", ["共同词 助手二"])];
  const result = matchConversationText("共同词 标题", events, "共同词");
  assert.deepEqual(result?.matches?.map(match => [match.textId, match.role]), [
    ["one_user_text", "user"], ["one_m1_text_0", "assistant"],
    ["two_user_text", "user"], ["two_m1_text_0", "assistant"],
  ]);
  assert.equal(result?.textId, "one_user_text", "older clients retain their first-match contract");
  assert.equal(result?.matches?.length, 4, "one result per message, not one per repeated word");
});
