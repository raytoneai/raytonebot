import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("conversation composer options override host defaults and reach the existing controls", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { ComposerFrame } = await server.ssrLoadModule("/src/components/agent-preview/ComposerFrame.tsx");
    const { ShellExtrasProvider } = await server.ssrLoadModule("/src/components/shell/ShellExtras.tsx");
    const { LocaleProvider } = await server.ssrLoadModule("/src/i18n/LocaleContext.tsx");
    const { project } = await server.ssrLoadModule("/src/exported-project.ts");
    const render = (value: unknown) => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh" },
      createElement(ShellExtrasProvider, { value }, createElement(ComposerFrame, {
        project, modelOptions: ["deepseek-flash"], defaultPermissionMode: "auto",
        onSubmit() {}, onProviderChange() {}, onModelChange() {},
      }))));
    const defaults = render({});
    assert.match(defaults, /替我批准/);
    const controlled = render({ composerOptions: { value: { permissionMode: "request", budgetMode: "expert" }, onChange() {} } });
    assert.match(controlled, /请求权限/);
    assert.doesNotMatch(controlled, /替我批准/);
    assert.match(controlled, /专家/);
    assert.match(defaults, /中等/);

    // Background persistence must not announce each keystroke or option change.
    for (const prompt of ["", "待发送的内容"]) {
      for (const status of ["saving", "saved"]) {
        const html = render({
          composerDraft: { value: { prompt, attachments: [], runOptions: { permissionMode: "request", budgetMode: "expert" } }, status, onChange() {} },
          composerOptions: { value: { permissionMode: "request", budgetMode: "expert" }, onChange() {} },
        });
        assert.doesNotMatch(html, /composer-draft-status/, `${status}: ${prompt || "options only"}`);
        assert.match(html, /请求权限/);
        assert.match(html, /专家/);
      }
    }
    // Loading blocks submission, and persistence/stop failures still need visible feedback.
    for (const [status, message] of [["loading", "正在恢复"], ["unavailable", "未保存"], ["conflict", "其他标签页"]]) {
      const html = render({ composerDraft: { value: { prompt: "", attachments: [] }, status, onChange() {} } });
      assert.match(html, /composer-draft-status/);
      assert.ok(html.includes(message), status);
    }
    for (const stopStatus of ["pending", "failed"]) {
      const html = render({ stopStatus, composerDraft: { value: { prompt: "", attachments: [] }, status: "saved", onChange() {} } });
      assert.match(html, /composer-draft-status/);
      assert.doesNotMatch(html, /草稿已保存/);
    }
  } finally { await server.close(); }
});
