import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("HeaderAgent history trigger keeps native button semantics while profile keeps its menu", {
  skip: !findHeadlessShell() && "Chromium not installed",
  timeout: 60_000,
}, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-header-agent-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "header-agent-test", configureServer(vite) {
      vite.middlewares.use("/header-agent-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/header-agent-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { HeaderAgent } from '/src/components/shell/ShellExtras.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          const avatars = { assistant: 'woman', planner: 'man', builder: 'boy', dsh: 'woman' };
          const settings = { presetId: 'assistant', claudeCodeModelSource: 'provider', codexModelSource: 'provider' };
          const bot = { id: 'assistant', presetId: 'assistant', name: 'Raer' };
          function Probe() {
            const [history, setHistory] = useState(0);
            const [historyEdit, setHistoryEdit] = useState(0);
            const [menuEdit, setMenuEdit] = useState(0);
            const [managed, setManaged] = useState('');
            const [providers, setProviders] = useState(0);
            const common = { avatars, settings, providerLabel: 'Provider (Model)', onChange() {}, onManageProviders: () => setProviders(count => count + 1), bot };
            return h(LocaleProvider, { initialLocale: 'en' }, h('main', null,
              h('section', { id: 'history-probe' }, h(HeaderAgent, { ...common, onOpenHistory: () => setHistory(count => count + 1), onEditBot: () => setHistoryEdit(count => count + 1) })),
              h('output', { id: 'history-count' }, String(history)),
              h('output', { id: 'history-edit-count' }, String(historyEdit)),
              h('section', { id: 'menu-probe' }, h(HeaderAgent, { ...common, profile: true, onEditBot: () => setMenuEdit(count => count + 1), onManageBot: section => setManaged(section) })),
              h('output', { id: 'menu-edit-count' }, String(menuEdit)),
              h('output', { id: 'managed' }, managed),
              h('output', { id: 'providers' }, String(providers)),
            ));
          }
          createRoot(document.getElementById('root')).render(h(Probe));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    page.setDefaultTimeout(5_000);
    await page.route("**/__agentcanvas/pi/bots", route => route.fulfill({ json: { revision: 0, profiles: [] } }));
    const base = server.resolvedUrls!.local[0];
    await page.goto(`${base}header-agent-test`, { waitUntil: "domcontentloaded" });

    const historyButton = page.locator("#history-probe button.shell-header-agent");
    await historyButton.waitFor({ state: "visible" });
    assert.equal(await historyButton.count(), 1);
    for (const attribute of ["aria-expanded", "aria-haspopup", "aria-controls"]) {
      assert.equal(await historyButton.getAttribute(attribute), null, `history trigger should not expose Radix ${attribute}`);
    }
    await historyButton.click();
    await historyButton.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#history-count").textContent(), "3");
    assert.equal(await page.locator("[data-radix-popper-content-wrapper]").count(), 0);
    assert.equal(await page.locator("[role=dialog]").count(), 0);
    await historyButton.click({ button: "right" });
    assert.equal(await page.locator("#history-edit-count").textContent(), "1");

    const profileButton = page.locator("#menu-probe button.shell-profile-agent");
    assert.equal(await profileButton.getAttribute("aria-haspopup"), "dialog");
    await profileButton.click();
    await page.getByRole("button", { name: "Edit this Bot", exact: true }).click();
    assert.equal(await page.locator("#menu-edit-count").textContent(), "1");
    await profileButton.click();
    await page.getByRole("button", { name: /This Bot’s memories/ }).click();
    assert.equal(await page.locator("#managed").textContent(), "memory");
    await profileButton.click();
    await page.getByRole("button", { name: "Manage model services", exact: true }).click();
    assert.equal(await page.locator("#providers").textContent(), "1");
    await profileButton.click();
    await page.keyboard.press("Escape");
    await page.locator(".shell-popover").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("shell-profile-agent"));
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
