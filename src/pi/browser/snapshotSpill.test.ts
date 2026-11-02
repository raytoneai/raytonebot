import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserService, findHeadlessShell } from "./browserService.ts";

const options = { skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000 };
const id = (text: string) => /^Snapshot: (.+)$/m.exec(text)![1];
const body = (text: string) => text.slice(text.indexOf("\n\n") + 2);
const page = (text: string) => {
  const match = /^Excerpt: characters (\d+)–(\d+) of (\d+); truncated=(true|false); nextOffset=(\d+|none)\.$/m.exec(text);
  assert.ok(match, text);
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]), next: match[5] === "none" ? undefined : Number(match[5]), text: body(text) };
};

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-snapshot-spill-"));
  const content = "A".repeat(1500) + "\n" + "界".repeat(3999) + "😀" + "\n" + "B".repeat(13_000) + "\nlast line";
  const article = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. ` + "This controlled article paragraph describes local browser reading, exact retained text and bounded page delivery. ".repeat(9));
  let slowResponse: ServerResponse | undefined;
  let slowStarted!: () => void;
  const started = new Promise<void>(resolve => { slowStarted = resolve; });
  const site = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/slow") { slowResponse = res; slowStarted(); return; }
    if (req.url === "/article") { res.end(`<title>Spill fixture</title>${article.map(paragraph => `<p>${paragraph}</p>`).join("")}`); return; }
    res.end(`<title>Spill fixture</title><pre>${req.url === "/small" ? "Small text 界😀" : content}</pre><input aria-label="Note">`);
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const browser = createBrowserService({ dataDir, allowAddress: address => address === "127.0.0.1", allowPort: value => value === port });
  let runId: string | undefined = "run-1";
  const tools = (conversationId = "a") => browser.toolsFor({ conversationId, agent: "assistant", currentRunId: () => runId,
    ask: async () => null, saveDownload: async () => "unused" })!;
  return { browser, content, article: article.map(paragraph => paragraph.trim()).join("\n"), tools, started, finishSlow: () => slowResponse?.end("<p>Late result</p>"),
    setRun: (value: string | undefined) => { runId = value; }, url: (path = "/") => `http://127.0.0.1:${port}${path}`,
    async close() { slowResponse?.end(); await browser.stop(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("content Spill reconstructs exact Unicode/newline text within budgets; small/full/interactive/action sizes stay compatible", options, async t => {
  const f = await fixture(), tools = f.tools();
  try {
    const opened = await tools.run("browser_open", { url: f.url() });
    assert.equal(opened.isError, false, opened.text);
    assert.doesNotMatch(opened.text, /Excerpt:/);
    assert.ok(Number(/Snapshot characters 0–(\d+) of/.exec(opened.text)![1]) <= 8000);
    const full = await tools.run("browser_snapshot", {});
    assert.doesNotMatch(full.text, /Excerpt:/);
    assert.ok(Number(/Snapshot characters 0–(\d+) of/.exec(full.text)![1]) <= 15000);
    const legacyPage = await tools.run("browser_snapshot", { snapshotId: id(full.text), offset: 40, limit: 15000 });
    assert.equal(legacyPage.isError, false, legacyPage.text);
    assert.doesNotMatch(legacyPage.text, /Excerpt:/);
    const interactive = await tools.run("browser_snapshot", { mode: "interactive" });
    assert.doesNotMatch(interactive.text, /Excerpt:/);
    assert.match(interactive.text, /textbox "Note"/);
    const initial = await tools.run("browser_snapshot", { mode: "content" });
    assert.equal(initial.isError, false, initial.text);
    const first = page(initial.text), snapshotId = id(initial.text);
    assert.equal(first.end, 1500, "newline at the exclusive limit must not add a character");
    let reconstructed = first.text, next = first.next;
    while (next !== undefined) {
      const result = await tools.run("browser_snapshot", { snapshotId, offset: next });
      assert.equal(result.isError, false, result.text);
      assert.equal(id(result.text), snapshotId);
      const part = page(result.text);
      assert.equal(part.start, next);
      assert.equal(part.end - part.start, part.text.length);
      assert.ok(part.text.length <= 4000);
      if (part.next === undefined) {
        assert.match(result.text, /truncated=false; nextOffset=none/);
        assert.match(result.text, /End of retained snapshot\. No further continuation is needed/);
        assert.doesNotMatch(result.text, /Read retained text|offset=\d+/);
      } else assert.match(result.text, new RegExp(`Read retained text.*offset=${part.next},`));
      assert.doesNotMatch(part.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      reconstructed += part.text; next = part.next;
    }
    assert.equal(reconstructed, f.content + "\n\nLinks:\n");
    assert.equal(first.total, reconstructed.length);
    const reread = await tools.run("browser_snapshot", { snapshotId, offset: 0, limit: 1500 });
    assert.equal(reread.isError, false, "explicit offset=0 reread remains available after the final page");
    assert.equal(id(reread.text), snapshotId);
    assert.equal(page(reread.text).text, first.text);
    const boundary = await tools.run("browser_snapshot", { snapshotId, offset: 1501, limit: 4000 });
    assert.equal(page(boundary.text).text, "界".repeat(3999), "page ends before the surrogate pair at its limit");
    await tools.run("browser_open", { url: f.url("/small") });
    const small = await tools.run("browser_snapshot", { mode: "content" });
    assert.equal(small.isError, false, small.text);
    assert.doesNotMatch(small.text, /Excerpt:|nextOffset/);
    assert.equal(body(small.text), "Small text 界😀\n\nLinks:\n");
    await tools.run("browser_open", { url: f.url("/article") });
    const article = await tools.run("browser_snapshot", { mode: "content" });
    assert.equal(article.isError, false, article.text);
    const retained = f.article + "\n\nLinks:\n";
    assert.equal(page(article.text).total, retained.length);
    assert.equal(page(article.text).text, retained.slice(0, page(article.text).end));
    const header = article.text.slice(0, article.text.indexOf("\n\n")).split("\n").filter(line => !line.startsWith("Excerpt:") && !line.startsWith("Read retained text")).join("\n");
    // Exact pre-Spill describe algorithm, including its newline selection and original footer.
    const oldEnd = Math.min(retained.length, 15000), lineEnd = retained.lastIndexOf("\n", oldEnd);
    const oldCut = oldEnd < retained.length && lineEnd > 0 ? lineEnd + 1 : oldEnd;
    const oldMore = oldCut < retained.length ? `\n[Snapshot characters 0–${oldCut} of ${retained.length}. Call browser_snapshot with offset=${oldCut} for more.]` : "";
    const baseline = `${header}\n\n${retained.slice(0, oldCut)}${oldMore}`;
    t.diagnostic(JSON.stringify({ fixture: "30 controlled article paragraphs; exact prior describe algorithm vs current Spill; UTF-8 bytes including header/notes/continuation metadata", priorBudget: 15000, priorReturnedCharacters: oldCut, priorResponseBytes: Buffer.byteLength(baseline), initialBudget: 1500, initialReturnedCharacters: page(article.text).end, initialResponseBytes: Buffer.byteLength(article.text), totalCharacters: retained.length }));
  } finally { await f.close(); }
});

test("retained snapshots reject invalid identities, ranges, changed runs, takeover and clearing", options, async () => {
  const f = await fixture(), tools = f.tools(), other = f.tools("b");
  const fresh = async () => { const shot = await tools.run("browser_snapshot", { mode: "content" }); assert.equal(shot.isError, false, shot.text); return id(shot.text); };
  const denied = async (args: unknown) => { const result = await tools.run("browser_snapshot", args); assert.equal(result.isError, true, result.text); };
  try {
    await tools.run("browser_open", { url: f.url() });
    let snapshotId = await fresh();
    for (const args of [
      { offset: 1500 }, { offset: 0 }, { snapshotId: "wrong", offset: 1500 }, { snapshotId: "", offset: 0 },
      ...[-1, 0.5, "1500", NaN, Infinity, 999999, 5501].map(offset => ({ snapshotId, offset })),
      ...[0, -1, 0.5, "100", NaN, Infinity, 4001].map(limit => ({ snapshotId, offset: 0, limit })),
      ...["mode", "scope", "frameRef"].map(key => ({ snapshotId, offset: 0, [key]: key === "mode" ? "content" : "main" })),
    ]) await denied(args);
    assert.equal((await other.run("browser_snapshot", { snapshotId, offset: 0 })).isError, true);
    const stopped = new AbortController(); stopped.abort();
    assert.equal((await tools.run("browser_snapshot", { snapshotId, offset: 0 }, stopped.signal)).isError, true);
    const replacement = await fresh(); assert.notEqual(replacement, snapshotId);
    await denied({ snapshotId, offset: 1500 }); snapshotId = replacement;
    f.setRun("run-2");
    await denied({ snapshotId, offset: 0 });
    assert.equal((await tools.run("browser_screenshot", { snapshotId })).isError, true);
    snapshotId = await fresh();
    f.browser.releaseRun("a", "run-1");
    f.browser.releaseRun("b", "run-2");
    assert.equal((await tools.run("browser_snapshot", { snapshotId, offset: 0 })).isError, false, "old/other run release cannot clear current snapshot");
    f.browser.releaseRun("a", "run-2");
    await denied({ snapshotId, offset: 0 });
    f.setRun("run-3"); snapshotId = await fresh();
    await f.browser.takeover(); await denied({ snapshotId, offset: 0 });
    await f.browser.release(); await denied({ snapshotId, offset: 0 });
    snapshotId = await fresh(); await f.browser.clearLogins(); await denied({ snapshotId, offset: 0 });
    await tools.run("browser_open", { url: f.url() }); snapshotId = await fresh();
    await f.browser.stop(); await denied({ snapshotId, offset: 0 });
    f.setRun(undefined); await denied({ mode: "content" });
    f.setRun("reused-conversation-new-run");
    await tools.run("browser_open", { url: f.url() });
    await denied({ snapshotId, offset: 0 });
    await fresh();
  } finally { await f.close(); }
});

test("run release or changed live run blocks late results and queued actions from resurrecting snapshots", options, async t => {
  for (const release of [true, false]) await t.test(release ? "released call with unchanged getter" : "changed getter without release", async () => {
  const f = await fixture(), tools = f.tools();
  try {
    const opened = await tools.run("browser_open", { url: f.url() });
    const controls = await tools.run("browser_snapshot", { mode: "interactive" });
    const oldRef = /textbox "Note" \[ref=([a-z0-9]+)\]/.exec(controls.text)![1];
    f.setRun("run-2");
    assert.equal((await tools.run("browser_type", { ref: oldRef, text: "stale" })).isError, true);
    const late = tools.run("browser_open", { url: f.url("/slow") });
    await f.started;
    const queued = tools.run("browser_snapshot", { mode: "content" });
    if (release) f.browser.releaseRun("a", "run-2");
    else f.setRun("run-3");
    f.finishSlow();
    assert.equal((await late).isError, true);
    assert.equal((await queued).isError, true);
    f.setRun("run-3");
    assert.equal((await tools.run("browser_snapshot", { snapshotId: id(opened.text), offset: 0 })).isError, true);
    const fresh = await tools.run("browser_snapshot", { mode: "content" });
    assert.equal(fresh.isError, false, fresh.text);
    assert.match(fresh.text, /Late result/);
  } finally { await f.close(); }
  });
});
