import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { settingsCopy } from "../i18n/copy/settings.ts";

test("provider picker supports search, local logos, keyboard adding and draft save/discard in both themes and mobile", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 120_000,
}, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-provider-catalog-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "provider-catalog-test", configureServer(vite) {
      vite.middlewares.use("/provider-catalog-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/provider-catalog-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SettingsDialog } from '/src/components/settings/SettingsDialog.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { project } from '/src/exported-project.ts';
          import { applyTheme } from '/src/theme/applyTheme.ts';
          import { themeTokens } from '/src/theme/themeTokens.ts';
          import '/src/styles/app.css';
          import '/src/styles/agentmatrix.css';
          const params = new URLSearchParams(location.search);
          const theme = params.get('theme') || 'soft-glass';
          applyTheme(themeTokens[theme]);
          function Probe() {
            const [current, setCurrent] = useState(project);
            return h(SettingsDialog, { open: true, onOpenChange() {}, project: current, isRunning: false, sessionKeys: {},
              onSessionKeyChange() {}, onUpdateProvider() {}, onSetDefaultProvider() {}, onPermissionDefaultChange() {},
              themePreset: theme, onThemeChange() {}, onSaveProviders(providers, keys) {
                window.savedProviderDraft = { providers, keys };
                setCurrent({ ...current, providers });
              } });
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: params.get('locale') || 'en' }, h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    for (const locale of ["en", "zh", "ja"] as const) for (const width of [1280, 390]) for (const theme of ["soft-glass", "warm-graphite"]) {
      await t.test(`${locale} / ${width}px / ${theme}`, async () => {
        const page = await browser!.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce", colorScheme: theme === "soft-glass" ? "light" : "dark" });
        page.setDefaultTimeout(5_000);
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        const copy = settingsCopy[locale].providers;
        try {
          await page.route("**/*", route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
          await page.goto(`${base}provider-catalog-test?locale=${locale}&theme=${theme}`, { waitUntil: "networkidle" });
          await page.getByRole("button", { name: copy.add, exact: true }).click();
          const search = page.getByRole("searchbox", { name: copy.search });
          assert.equal(await search.evaluate(el => el === document.activeElement), true);
          assert.equal(await page.locator(".settings-tile").count(), 14);
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".settings-mark img")].every(img => img.complete && img.naturalWidth > 0));
          assert.equal(await page.locator(".settings-tile .settings-mark img").count(), 12);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await page.locator(".settings-provider-catalog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
          if (process.env.PROVIDER_SCREENSHOT_DIR) {
            mkdirSync(process.env.PROVIDER_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.PROVIDER_SCREENSHOT_DIR, `catalog-${locale}-${width}-${theme}.png`) });
            await page.locator(".settings-tile").last().scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.PROVIDER_SCREENSHOT_DIR, `catalog-bottom-${locale}-${width}-${theme}.png`) });
          }
          await search.fill("no-such-provider");
          await page.getByRole("status").filter({ hasText: copy.noResults }).waitFor();
          await search.fill("  IRUIDONG.COM ");
          assert.equal(await page.locator(".settings-tile").count(), 1);
          const add = page.getByRole("button", { name: `${copy.add} Raytone`, exact: true });
          await add.focus();
          await page.keyboard.press("Enter");
          const editor = page.locator(".settings-provider-editor");
          assert.equal(await editor.locator("input").first().inputValue(), "https://iruidong.com/v1");
          assert.equal(await editor.locator("input").first().evaluate(el => el === document.activeElement), true);
          await page.getByRole("button", { name: copy.discard, exact: true }).click();
          assert.equal(await page.locator(".settings-provider").count(), 1);
          await page.getByRole("button", { name: copy.add, exact: true }).click();
          await page.getByRole("searchbox", { name: copy.search }).fill("Raytone");
          await page.getByRole("button", { name: `${copy.add} Raytone`, exact: true }).click();
          await page.locator('input[type="password"]').fill("dummy-provider-key");
          await page.getByRole("button", { name: copy.save, exact: true }).click();
          const saved = await page.evaluate(() => (window as any).savedProviderDraft);
          assert.equal(saved.providers.defaultProviderId, "deepseek");
          assert.equal(saved.providers.connections.find((p: any) => p.id === "raytone").enabled, true);
          assert.equal(saved.keys.raytone, "dummy-provider-key");
          assert.equal(await page.locator('input[type="password"]').inputValue(), "");
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  } finally {
    await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true });
  }
});
