import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXTimelineItem, AgentUXToolTimelineItem } from "@agent-ux/render-core";

import { foldQuietTools, isQuietTool, toolRunSummary } from "./toolSummary.ts";

const tool = (id: string, name: string, status = "success") => ({ kind: "tool", id, name, status }) as unknown as AgentUXToolTimelineItem;
const thought = (id: string) => ({ kind: "reasoning", id, status: "done" }) as unknown as AgentUXTimelineItem;
const message = (id: string) => ({ kind: "message", id, role: "assistant", text: "hi", status: "done" }) as unknown as AgentUXTimelineItem;

test("reads, searches and commands from every engine are quiet; edits, unknown tools and live calls are not", () => {
  for (const name of ["bash", "Bash", "read", "Read", "grep", "Grep", "find", "ls", "Glob", "web_search", "WebSearch", "WebFetch"]) {
    assert.ok(isQuietTool(tool("t", name)), name);
  }
  for (const name of ["edit", "Edit", "write", "Write", "update_plan", "ask_user", "connect_channel", "frobnicate"]) {
    assert.ok(!isQuietTool(tool("t", name)), name);
  }
  for (const status of ["running", "args_streaming", "awaiting_approval"]) assert.ok(!isQuietTool(tool("t", "bash", status)), status);
  assert.ok(isQuietTool(tool("t", "bash", "error")), "a failed command is folded too, and counted");
});

test("consecutive quiet tools fold into one segment; edits and messages break the run; hidden thoughts do not", () => {
  const items = [thought("r1"), tool("a", "bash"), thought("r2"), tool("b", "read"), tool("c", "edit"), tool("d", "bash"), message("m")];
  const segments = foldQuietTools(items, (item) => item.kind === "reasoning");
  assert.deepEqual(segments.map((s) => s.kind === "tools" ? `[${s.tools.map((t) => t.id).join("")}]` : s.item.id), ["r1", "[ab]", "r2", "c", "[d]", "m"]);
});

test("the summary counts each kind once, in order, and the failures", () => {
  assert.equal(toolRunSummary([tool("a", "bash"), tool("b", "read"), tool("c", "bash", "error")], "zh"), "运行了 2 条命令 · 读取了 1 个文件 · 1 个失败");
  assert.equal(toolRunSummary([tool("a", "read"), tool("b", "grep")], "en"), "Read 1 file, searched 1 time");
  assert.equal(toolRunSummary([tool("a", "bash")], "en"), "Ran 1 command");
  assert.equal(toolRunSummary([tool("a", "ls"), tool("b", "WebFetch"), tool("c", "Glob")], "zh"), "搜索了 2 次 · 查阅了 1 次网页");
});
