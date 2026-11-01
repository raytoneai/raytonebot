import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

/**
 * The routine settings surface must not offer an empty conversation after a pre-start failure.
 * A previous accepted run, however, still owns the same routine conversation and remains openable
 * even when the newest history entry failed before the engine started.
 */
test("routine result navigation only opens an existing conversation", {
  skip: !findHeadlessShell() && "Chromium not installed",
  timeout: 60_000,
}, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-routine-controls-browser-"));
  const server = await createServer({
    root: process.env.RAYTONEBOT_TEST_ROOT ?? process.cwd(),
    configFile: false,
    cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [react(), {
      name: "routine-controls-browser-test",
      configureServer(vite) {
        vite.middlewares.use("/routine-controls-test", async (_req, res) => {
          res.setHeader("content-type", "text/html");
          res.end(await vite.transformIndexHtml("/routine-controls-test", `<!doctype html>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <div id="root"></div>
            <script type="module">
              import { createElement as h, useState } from 'react';
              import { createRoot } from 'react-dom/client';
              import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
              import { settingsCopy } from '/src/i18n/copy/settings.ts';
              import { RoutinesSection } from '/src/components/settings/RoutinesSection.tsx';
              import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
              import '/src/styles/app.css';
              import '/src/components/settings/settings.css';

              const conversationId = 'routine-conversation-browser';
              const baseRun = { at: 1_700_000_000_000, status: 'error', occurrenceId: 'failed-now', error: 'Provider rejected configuration.' };
              const oldSuccess = { at: 1_699_999_000_000, status: 'success', occurrenceId: 'accepted-before', runId: 'routine_run_before', textId: 'text-before' };
              const scenarios = {
                failed: { lastRun: baseRun, history: [baseRun] },
                recovered: { lastRun: baseRun, history: [baseRun, oldSuccess] },
                running: { lastRun: { ...oldSuccess, occurrenceId: 'running-now', status: 'running', at: 1_700_000_100_000 }, history: [{ ...oldSuccess, occurrenceId: 'running-now', status: 'running', at: 1_700_000_100_000 }] },
                finished: { lastRun: oldSuccess, history: [oldSuccess] },
              };

              function Probe() {
                const scenario = new URLSearchParams(location.search).get('scenario') || 'failed';
                const [opened, setOpened] = useState('');
                const selected = scenarios[scenario] || scenarios.failed;
                const routine = { id: 'routine-browser', botId: 'assistant', title: 'Morning report', schedule: '0 9 * * 1-5', timezone: 'Asia/Shanghai', instructions: 'Check the morning report.', enabled: true, createdAt: 1_699_000_000_000, revision: 1, conversationId, failures: 0, ...selected };
                const state = { routines: [routine], setEnabled: async () => {}, runNow: async () => {}, remove: async () => {}, update: async () => true };
                const open = (id, target) => setOpened(JSON.stringify({ id, target: target?.runId || target?.textId || '' }));
                return h(ShellExtrasProvider, { value: {} },
                  h('main', { className: 'settings-dialog', 'data-scenario': scenario },
                    h('div', { className: 'settings-body' },
                      h('div', { className: 'settings-body-scroll' },
                        h(RoutinesSection, { t: settingsCopy.en, state, onOpenConversation: open, drafts: {}, onDraft: () => {} }),
                        opened ? h('output', { 'data-opened-conversation': opened }) : null))));
              }
              createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: 'en' }, h(Probe)));
            </script>`));
        });
      },
    }],
  });
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls!.local[0];
    for (const scenario of ["failed", "recovered", "running", "finished"]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${baseUrl}routine-controls-test?scenario=${scenario}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        const openConversation = page.getByRole("button", { name: "Open conversation", exact: true });
        if (scenario === "failed") {
          assert.equal(await openConversation.isDisabled(), true, "a pre-start-only failure cannot open an empty conversation");
          assert.equal(await page.locator("[data-opened-conversation]").count(), 0);
        } else {
          assert.equal(await openConversation.isDisabled(), false, `${scenario} keeps its routine conversation openable`);
          await openConversation.click();
          assert.deepEqual(JSON.parse(await page.locator("[data-opened-conversation]").getAttribute("data-opened-conversation") ?? "{}"), { id: "routine-conversation-browser", target: "" });
          const result = page.getByRole("button", { name: "View result", exact: true });
          assert.equal(await result.count(), 1, `${scenario} keeps its result anchor visible`);
          await result.click();
          assert.deepEqual(JSON.parse(await page.locator("[data-opened-conversation]").getAttribute("data-opened-conversation") ?? "{}"), { id: "routine-conversation-browser", target: "routine_run_before" });
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${scenario} fits a 390px viewport`);
        if (process.env.RAYTONEBOT_ROUTINE_SCREENSHOT) {
          const dir = join(process.cwd(), "output/routine-reliability-2026-11-01");
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: join(dir, `routine-${scenario}-mobile.png`), fullPage: false });
        }
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
