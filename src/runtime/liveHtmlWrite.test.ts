import assert from "node:assert/strict";
import test from "node:test";
import { finishedHtmlEdits, liveHtmlWrite, partialJsonString, streamingHtmlBody } from "./liveHtmlWrite.ts";

const tool = (status: string, argsText: string, name = "write", args?: unknown) => ({ kind: "tool", id: "t1", name, status, argsText, args });

test("partial JSON strings decode up to the last complete character", () => {
  assert.equal(partialJsonString('{"content":"<h1>Hi\\n</h1', "content"), "<h1>Hi\n</h1");
  assert.equal(partialJsonString('{"content":"a\\"b\\u00e9c\\u00', "content"), 'a"béc');
  assert.equal(partialJsonString('{"content":"ends with \\', "content"), "ends with ");
  assert.equal(partialJsonString('{"path":"a/b.ht', "path", true), undefined, "a half-written path is not a path");
  assert.equal(partialJsonString('{"path":"a/b.html","content":"x', "path", true), "a/b.html");
  assert.equal(partialJsonString('{"other":1}', "content"), undefined);
});

test("only a write of an .html file still in progress is live", () => {
  const text = '{"path":"/w/agents/assistant/calc.html","content":"<h1>Bill</h1><p>To';
  assert.deepEqual(liveHtmlWrite([tool("args_streaming", text)]), { toolCallId: "t1", path: "/w/agents/assistant/calc.html", title: "calc.html", html: "<h1>Bill</h1><p>To", status: "args_streaming" });
  assert.equal(liveHtmlWrite([tool("args_streaming", text, "Write")])?.title, "calc.html", "Claude Code's Write");
  assert.equal(liveHtmlWrite([tool("args_streaming", '{"file_path":"x.htm","content":"<p>"', "Write")])?.path, "x.htm");
  assert.equal(liveHtmlWrite([tool("success", text)]), undefined, "a finished write opens the real file instead");
  assert.equal(liveHtmlWrite([tool("args_streaming", '{"path":"notes.md","content":"# x"')]), undefined);
  assert.equal(liveHtmlWrite([tool("args_streaming", text, "edit")]), undefined, "a diff fragment is not a page");
  assert.equal(liveHtmlWrite([tool("running", "", "write", { path: "a.html", content: "<b>done</b>" })])?.html, "<b>done</b>");
});

test("a page in progress shows no scripts and no half-written tag", () => {
  assert.equal(streamingHtmlBody("<p>a</p><script>run()</script><p>b</p><scr"), "<p>a</p><p>b</p>");
  assert.equal(streamingHtmlBody("<p>a</p><script>half"), "<p>a</p>");
  assert.equal(streamingHtmlBody("<p>a</p><div class=\"x"), "<p>a</p>");
  assert.equal(streamingHtmlBody("<style>p{color:red}</style><p>ok"), "<style>p{color:red}</style><p>ok");
});

test("an .html edit that finishes in a live run opens; restored history does not", () => {
  const run = { kind: "run", id: "r1" };
  const live = () => true;
  const edit = (status: string, path = "/w/agents/developer/roi.html") => ({ ...tool(status, "", "edit", { path, changes: [] }), id: "e1" });
  const opened = [{ path: "/w/agents/developer/roi.html", title: "roi.html", toolCallId: "e1" }];
  assert.deepEqual(finishedHtmlEdits([run, edit("running")], [run, edit("success")], live), opened, "seen running, then saved");
  assert.deepEqual(finishedHtmlEdits([], [run, edit("success")], live), opened, "a new conversation's first turn, started and finished in one frame");
  assert.deepEqual(finishedHtmlEdits([run, edit("success")], [run, edit("success"), { kind: "text", id: "x" }], live), [], "opens once");
  assert.deepEqual(finishedHtmlEdits([], [run, edit("success")], () => false), [], "restored history: no live run");
  assert.deepEqual(finishedHtmlEdits([run, edit("running")], [run, edit("error")], live), []);
  assert.deepEqual(finishedHtmlEdits([run, edit("running", "a.md")], [run, edit("success", "a.md")], live), []);
  assert.deepEqual(finishedHtmlEdits([run], [run, { ...tool("success", "", "write", { path: "a.html", content: "<p>" }), id: "w1" }], live), [], "writes with content open through the live preview");
  assert.deepEqual(finishedHtmlEdits([run, { ...tool("running", "", "write", { path: "new.html", changes: [{ path: "new.html", kind: "add" }] }), id: "w2" }],
    [run, { ...tool("success", "", "write", { path: "new.html", changes: [{ path: "new.html", kind: "add" }] }), id: "w2" }], live), [{ path: "new.html", title: "new.html", toolCallId: "w2" }], "Codex's add has no content to stream");
  const patch = { path: "app.ts", changes: [{ path: "app.ts", kind: "update" }, { path: "page.html", kind: "update" }, { path: "old.html", kind: "delete" }, { path: "a.htm", kind: "update", move_path: "b.html" }] };
  assert.deepEqual(finishedHtmlEdits([run], [run, { ...tool("success", "", "edit", patch), id: "p1" }], live).map((file) => file.path), ["page.html", "b.html"], "every changed page, not deletions");
});
