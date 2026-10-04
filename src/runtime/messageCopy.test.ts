import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { branchMessageRuns, branchReplayEvents } from "./useMessageBranch.ts";

test("real user and assistant messages expose copy, while empty streaming placeholders cannot be copied", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { ChatFrame } = await server.ssrLoadModule("/src/components/agent-preview/ChatFrame.tsx");
    const { LocaleProvider } = await server.ssrLoadModule("/src/i18n/LocaleContext.tsx");
    const { IconSetProvider } = await server.ssrLoadModule("/src/agentmatrix/IconSetContext.tsx");
    const { project } = await server.ssrLoadModule("/src/exported-project.ts");
    const { ShellExtrasProvider } = await server.ssrLoadModule("/src/components/shell/ShellExtras.tsx");
    const adapter = createPiEventAdapter({ runId: "copy-test" });
    adapter.startUserMessage("真实提问");
    adapter.apply({ type: "message_start", message: { role: "assistant" } });
    const render = (branching = false) => renderToStaticMarkup(createElement(IconSetProvider, null,
      createElement(LocaleProvider, { initialLocale: "zh" }, createElement(ShellExtrasProvider, {
        value: branching ? { messageBranch: { canBranch: (id: string) => branchMessageRuns(adapter.events).has(id), run: async () => {} } } : {},
      }, createElement(ChatFrame, {
        project, previewPrompt: "", viewModel: createAgentUXViewModel(branchReplayEvents(adapter.events)),
      })))));
    const pending = render();
    assert.match(pending, /aria-label="复制提示词" type="button"/);
    assert.doesNotMatch(pending, /aria-label="复制回复"/);
    adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "真实回答" } });
    adapter.apply({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    adapter.finish("success");
    const completed = render();
    assert.match(completed, /aria-label="复制回复" type="button"/);
    assert.doesNotMatch(completed, /aria-label="复制回复" type="button" disabled/);
    assert.match(completed, /aria-label="在新分支中编辑提示词" type="button" disabled/);
    assert.match(completed, /aria-label="在新分支中重新生成（保留已写文件）" type="button" disabled/);
    const connected = render(true);
    assert.doesNotMatch(connected, /aria-label="在新分支中编辑提示词" type="button" disabled/);
    assert.doesNotMatch(connected, /aria-label="在新分支中重新生成（保留已写文件）" type="button" disabled/);
  } finally { await server.close(); }
});
