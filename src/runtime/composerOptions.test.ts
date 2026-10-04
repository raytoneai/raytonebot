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
  } finally { await server.close(); }
});
