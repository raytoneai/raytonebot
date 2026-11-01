import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("settings appearance radio groups use roving keyboard navigation", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-settings-radio-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "settings-radio-test", configureServer(vite) {
      vite.middlewares.use("/settings-radio-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/settings-radio-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppearanceSection } from '/src/components/settings/AppearanceSection.tsx';
          import { Segmented } from '/src/components/settings/SettingsShared.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { settingsCopy } from '/src/i18n/copy/settings.ts';
          import { useLocale } from '/src/i18n/LocaleContext.tsx';
          import '/src/styles/app.css'; import '/src/styles/agentmatrix.css';
          function Probe() {
            const [theme, setTheme] = useState('soft-glass');
            const [disabledValue, setDisabledValue] = useState('allowlist');
            const [themeChanges, setThemeChanges] = useState(0);
            const { locale } = useLocale();
            return h('main', null,
              h(AppearanceSection, { t: settingsCopy[locale], themePreset: theme, onThemeChange: value => { setTheme(value); setThemeChanges(count => count + 1); } }),
              h(Segmented, { ariaLabel: 'Disabled group', value: disabledValue, options: [{value:'allowlist',label:'Allowed'}, {value:'open',label:'Open'}], disabled: true, onChange: setDisabledValue }),
              h('output', { id: 'theme-changes' }, String(themeChanges)), h('button', { id: 'after-radios' }, 'After radios'));
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: 'en' }, h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    for (const width of [1280, 390]) await t.test(`${width}px`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5_000); page.setDefaultNavigationTimeout(30_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(`${base}settings-radio-test`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const groups = page.getByRole("radiogroup");
        assert.equal(await groups.count(), 3);
        for (const group of [groups.nth(0), groups.nth(1)]) {
          assert.equal(await group.locator('[role="radio"][tabindex="0"]').count(), 1);
          assert.equal(await group.locator('[role="radio"][tabindex="-1"]').count(), await group.locator('[role="radio"]').count() - 1);
        }
        const language = groups.nth(0);
        const languages = language.getByRole("radio");
        await language.getByRole("radio", { name: "English" }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await language.getByRole("radio", { name: "中文" }).getAttribute("aria-checked"), "true");
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), "中文");
        await page.keyboard.press("ArrowDown");
        assert.equal(await language.getByRole("radio", { name: "日本語" }).getAttribute("aria-checked"), "true");
        await page.waitForFunction(() => document.querySelectorAll('[role="radiogroup"]')[0]?.getAttribute("aria-label") === "言語");
        await page.keyboard.press("Home");
        assert.equal(await language.getByRole("radio", { name: "English" }).getAttribute("aria-checked"), "true");
        await page.waitForFunction(() => document.querySelectorAll('[role="radiogroup"]')[0]?.getAttribute("aria-label") === "Language");
        await page.keyboard.press("End");
        assert.equal(await language.getByRole("radio", { name: "日本語" }).getAttribute("aria-checked"), "true");
        await page.waitForFunction(() => document.querySelectorAll('[role="radiogroup"]')[0]?.getAttribute("aria-label") === "言語");
        await page.keyboard.press("ArrowRight");
        assert.equal(await language.getByRole("radio", { name: "English" }).getAttribute("aria-checked"), "true");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await language.getByRole("radio", { name: "日本語" }).getAttribute("aria-checked"), "true");
        await page.keyboard.press("Home");
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute("aria-label")), "Theme");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute("aria-label")), "Language");
        await page.keyboard.press("Tab");

        const themes = groups.nth(1), themeRadios = themes.getByRole("radio");
        const initialChanges = Number(await page.locator("#theme-changes").textContent());
        await themeRadios.first().focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator("#theme-changes").textContent(), String(initialChanges + 1));
        assert.equal(await themeRadios.nth(1).getAttribute("aria-checked"), "true");
        await page.keyboard.press("End");
        assert.equal(await themeRadios.last().getAttribute("aria-checked"), "true");
        await page.keyboard.press("ArrowDown");
        assert.equal(await themeRadios.first().getAttribute("aria-checked"), "true");
        await page.keyboard.press("ArrowUp");
        assert.equal(await themeRadios.last().getAttribute("aria-checked"), "true");
        const beforeSpace = Number(await page.locator("#theme-changes").textContent());
        await page.keyboard.press("Space");
        assert.equal(await page.locator("#theme-changes").textContent(), String(beforeSpace + 1));
        const beforeEnter = Number(await page.locator("#theme-changes").textContent());
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#theme-changes").textContent(), String(beforeEnter + 1));
        await themeRadios.first().click();
        assert.equal(await themeRadios.first().getAttribute("aria-checked"), "true");

        const disabled = groups.nth(2), disabledRadios = disabled.getByRole("radio");
        assert.equal(await disabledRadios.count(), 2);
        assert.equal(await disabled.locator('[tabindex="0"]').count(), 0);
        await disabledRadios.first().evaluate((node: HTMLButtonElement) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
        assert.equal(await disabledRadios.nth(1).getAttribute("aria-checked"), "false");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  } finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
