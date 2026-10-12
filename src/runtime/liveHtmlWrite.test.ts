import assert from "node:assert/strict";
import test from "node:test";
import { liveHtmlWrite, partialJsonString, streamingHtmlBody } from "./liveHtmlWrite.ts";

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
