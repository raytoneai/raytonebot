import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { createAgentUXViewModel, type AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createClaudeStreamTranslator } from "../pi/cliStreams.ts";
import { buildToolDisplaySpec } from "./toolDisplaySpec.ts";

let server: ViteDevServer;
let render: (tool: AgentUXToolTimelineItem, locale?: string) => string;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { ToolCallCard } = await server.ssrLoadModule("/src/components/agent-preview/ToolCallCard.tsx");
  const { IconSetProvider } = await server.ssrLoadModule("/src/agentmatrix/IconSetContext.tsx");
  const { LocaleProvider } = await server.ssrLoadModule("/src/i18n/LocaleContext.tsx");
  const { project } = await server.ssrLoadModule("/src/exported-project.ts");
  render = (tool, locale = "zh") => renderToStaticMarkup(createElement(IconSetProvider, null,
    createElement(LocaleProvider, { initialLocale: locale }, createElement(ToolCallCard, { project, tool, forceOpen: true }))));
});
after(async () => { await server?.close(); });

const toolFrom = (adapter: ReturnType<typeof createPiEventAdapter>) =>
  createAgentUXViewModel(adapter.events).timeline.find((item) => item.kind === "tool") as AgentUXToolTimelineItem;

test("native tool lifecycle renders honest titles and preserves failures instead of completed file rows", () => {
  const adapter = createPiEventAdapter({ runId: "read" });
  adapter.apply({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "image-test.ts" } });
  assert.match(render(toolFrom(adapter)), /正在读取文件/);
  adapter.apply({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "export const actual = 42;" }] } });
  const completed = { ...toolFrom(adapter), title: "正在读取文件 image-test.ts" };
  const html = render(completed);
  assert.match(html, /读取文件 · 已完成/);
  assert.doesNotMatch(html, /正在|data-running-title="true"|data-active="true"/);
  assert.deepEqual(buildToolDisplaySpec(completed).outputBlock, { kind: "code", lang: "typescript", code: "export const actual = 42;" });
  for (const [locale, label] of [["en", "Read file · Completed"], ["ja", "ファイルの読み取り · 完了"]]) {
    assert.ok(render(completed, locale).includes(label));
  }

  for (const status of ["error", "cancelled"] as const) {
    const failed = createPiEventAdapter({ runId: status });
    failed.apply({ type: "tool_execution_start", toolCallId: status, toolName: "edit", args: { path: "file.ts", oldText: "old", newText: "new" } });
    if (status === "error") failed.apply({ type: "tool_execution_end", toolCallId: status, toolName: "edit", isError: true, result: { content: [{ type: "text", text: "Original text not found" }] } });
    else failed.finish("cancelled");
    const markup = render(toolFrom(failed));
    assert.match(markup, status === "error" ? /编辑文件 · 失败/ : /编辑文件 · 已取消/);
    assert.doesNotMatch(markup, /已编辑|已修改|正在|data-artifact-ref=/);
    if (status === "error") assert.match(markup, /Original text not found/);
  }
  const approval = createPiEventAdapter({ runId: "approval", requiresApproval: () => true });
  approval.apply({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "file.ts", content: "proposal" } });
  assert.match(render(toolFrom(approval)), /修改文件 · 等待审批/);
  assert.match(render(toolFrom(approval)), /class="tool-preview">file.ts/);
  assert.doesNotMatch(render(toolFrom(approval)), /data-artifact-ref=|正在|已修改/);
  approval.resolveApproval("write", "no");
  assert.match(render(toolFrom(approval)), /已取消/);
  assert.match(render(toolFrom(approval)), /denied by the user/);
});

test("Claude edits show their requested diff separately from results, including failure receipts", () => {
  const adapter = createPiEventAdapter({ runId: "claude" });
  const translator = createClaudeStreamTranslator(adapter.apply);
  translator.push({ type: "assistant", message: { id: "message", content: [{ type: "tool_use", id: "edit", name: "Edit", input: { file_path: "app.ts", old_string: "before", new_string: "after" } }] } });
  translator.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edit", is_error: true, content: "permission denied" }] } });
  const spec = buildToolDisplaySpec(toolFrom(adapter));
  assert.deepEqual(spec.inputBlock, { kind: "diff", oldCode: "before", newCode: "after", lang: "typescript", path: "app.ts" });
  assert.deepEqual(spec.outputBlock, { kind: "plain", text: "permission denied" });
  assert.match(render(toolFrom(adapter)), /permission denied/);
  const unknown = { ...toolFrom(adapter), name: "report_metrics", title: "Reading image-test.ts", status: "success" };
  const markup = render(unknown);
  assert.doesNotMatch(markup, /data-action=|data-artifact-ref=|正在|data-running-title="true"/);
  assert.match(markup, /report_metrics · 已完成/);
});

test("image rows and validation aliases stop animating at completion, and partial arguments stay preparatory", () => {
  const image: AgentUXToolTimelineItem = { kind: "tool", id: "images", name: "read_image", status: "running",
    args: { path: "chart.png" }, result: { images: [{ path: "chart.png" }, { path: "second.png" }] } };
  assert.match(render(image), /data-active="true"/);
  const completed = render({ ...image, status: "success" });
  assert.doesNotMatch(completed, /data-active="true"|data-running-title="true"|正在/);
  assert.match(completed, /读取图片 · 已完成/);
  for (const name of ["run_tests", "run_checks"]) {
    assert.match(render({ kind: "tool", id: name, name, status: "success" }), /验证 · 已完成/);
  }
  assert.match(render({ kind: "tool", id: "partial", name: "bash", status: "args_streaming", argsText: '{"command":' }), /准备参数/);
  const edits = { path: "app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] };
  const spec = buildToolDisplaySpec({ kind: "tool", id: "multi", name: "edit", status: "error", args: edits, result: "Edits overlap" });
  assert.equal(spec.inputBlock?.kind, "code");
  if (spec.inputBlock?.kind === "code") assert.deepEqual(JSON.parse(spec.inputBlock.code), edits);
  assert.deepEqual(spec.outputBlock, { kind: "plain", text: "Edits overlap" });
});
