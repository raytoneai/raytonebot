import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("always-allowed reset reports pending/failure and only removes confirmed grants", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-permission-feedback-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "permission-feedback-test", configureServer(vite) {
      vite.middlewares.use("/permission-feedback-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/permission-feedback-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { PermissionsSection } from '/src/components/settings/PermissionsSection.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { settingsCopy } from '/src/i18n/copy/settings.ts';
          import '/src/styles/app.css'; import '/src/styles/agentmatrix.css';
          function Probe() {
            const [allowed, setAllowed] = useState({ assistant: ['read_file'], planner: ['search'] });
            const [mounted, setMounted] = useState(true);
            const layout = new URLSearchParams(location.search).get('layout') === '1';
            const paths = (prefix) => layout ? Array.from({ length: 65 }, (_, i) => '/very/long/' + prefix + '/nested/' + String(i).padStart(2, '0') + '/workspace/project/configuration/with-a-long-segment/settings.json') : undefined;
            const runtime = { alwaysAllowed: allowed, cwd: '/workspace/raytone', workspace: { agents: { assistant: '/workspace/raytone/assistant' }, shared: '/workspace/raytone/shared' }, secretPaths: paths('secret'), protectedPaths: paths('protected'), readOnlyPaths: paths('readonly') };
            const locale = new URLSearchParams(location.search).get('locale') || 'en';
            return h('main', { className: 'settings-body-scroll', style: { height: '660px', width: 'min(760px, calc(100vw - 32px))', margin: 'auto' } },
              h('button', { onClick: () => setAllowed({ assistant: ['read_file'], planner: ['search'] }) }, 'Send stale grants'),
              h('button', { onClick: () => setAllowed({ assistant: ['write_file'], planner: ['search'] }) }, 'Send new grants'),
              h('button', { onClick: () => setMounted(false) }, 'Unmount'),
              mounted ? h(PermissionsSection, { t: settingsCopy[locale], runtime, onPermissionDefaultChange() {} }) : h('p', null, 'Unmounted'));
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: new URLSearchParams(location.search).get('locale') || 'en' }, h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    const copy = [
      { locale: "en", reset: "Reset", pending: "Resetting…", failed: "Could not confirm the reset. Try again.", retry: "Try again" },
      { locale: "zh", reset: "重置", pending: "正在重置…", failed: "未能确认重置结果，请重试。", retry: "重试" },
      { locale: "ja", reset: "リセット", pending: "リセット中…", failed: "リセット結果を確認できませんでした。再試行してください。", retry: "再試行" },
    ];
    for (const width of [1280, 390]) for (const strings of copy) await t.test(`${width}px ${strings.locale}: pending, failure, retry and confirmed cleanup`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(30_000);
      const posts: unknown[] = [];
      const apiPaths: string[] = [];
      let release!: (route: Route) => void;
      const delayed = new Promise<Route>(resolve => { release = resolve; });
      let first = true;
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/__agentcanvas/pi/**", async route => {
        const path = new URL(route.request().url()).pathname;
        apiPaths.push(path);
        if (path.endsWith("/approvals/clear")) {
          posts.push(route.request().postDataJSON());
          if (first) { first = false; release(route); return; }
          const body = route.request().postDataJSON() as { agentPreset: string };
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ alwaysAllowed: body.agentPreset === "assistant" ? { planner: ["search"] } : { assistant: ["read_file"] } }) });
        }
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Unexpected request"}' });
      });
      try {
        await page.goto(`${base}permission-feedback-test?locale=${strings.locale}`, { waitUntil: "domcontentloaded" });
        const assistant = page.locator(".settings-list .settings-row").filter({ hasText: "read_file" });
        const button = page.getByRole("button", { name: strings.reset, exact: true }).first();
        await button.click();
        await page.getByRole("status").getByText(strings.pending, { exact: true }).waitFor();
        await button.click({ force: true });
        assert.equal(posts.length, 1, "duplicate clicks are locked before the request settles");
        assert.equal(await assistant.getByText("read_file", { exact: true }).count(), 1, "grant remains while request is pending");
        if (process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS && strings.locale === "en") {
          mkdirSync(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, `pending-${width}.png`) });
        }
        await (await delayed).fulfill({ status: 500, contentType: "application/json", body: '{"error":"offline"}' });
        await assistant.locator("[role=alert]").waitFor();
        assert.equal((await assistant.locator("[role=alert]").innerText()).trim(), strings.failed);
        if (process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS && strings.locale === "en") {
          await page.screenshot({ path: join(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, `failed-${width}.png`) });
        }
        assert.equal(await assistant.getByText("read_file", { exact: true }).count(), 1, "failure retains grant");
        await assistant.getByRole("button", { name: strings.retry, exact: true }).click();
        await assistant.waitFor({ state: "detached" });
        assert.equal(posts.length, 2, "explicit retry sends one request");
        await page.getByRole("button", { name: "Send stale grants" }).click();
        await page.waitForTimeout(50);
        assert.equal(await page.getByText("read_file", { exact: true }).count(), 1, "runtime props remain authoritative and can regrant the same tools");
        await page.getByRole("button", { name: "Send new grants" }).click();
        await page.getByText("write_file", { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(posts, [{ agentPreset: "assistant" }, { agentPreset: "assistant" }]);
        assert.deepEqual(apiPaths, ["/__agentcanvas/pi/approvals/clear", "/__agentcanvas/pi/approvals/clear"], "the harness makes no model or unrelated API calls");
      } finally { await page.close(); }
    });
    const layoutMetrics: Array<{ width: number; locale: string; workspaceTopPx: number; collapsedScrollHeightPx: number; pathCountPerCategory: number; totalPathCount: number }> = [];
    for (const width of [1280, 390]) for (const locale of ["en", "zh", "ja"]) await t.test(`${width}px ${locale}: workspace first and long policy paths disclosed on demand`, async () => {
      const labels = {
        en: { workspace: "Agent workspaces", secret: "Off limits", protected: "Protected paths", readOnly: "Files requiring confirmation to edit" },
        zh: { workspace: "助手工作目录", secret: "禁止访问", protected: "受保护路径", readOnly: "修改需确认的文件" },
        ja: { workspace: "エージェントの作業ディレクトリ", secret: "アクセス禁止", protected: "保護パス", readOnly: "変更に確認が必要なファイル" },
      }[locale]!;
      const page = await browser!.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(30_000);
      try {
        await page.goto(`${base}permission-feedback-test?locale=${locale}&layout=1`, { waitUntil: "domcontentloaded" });
        const workspace = page.getByRole("heading", { name: labels.workspace });
        const section = page.locator(".settings-body-scroll");
        const y = await workspace.evaluate(node => node.getBoundingClientRect().top - node.closest(".settings-body-scroll")!.getBoundingClientRect().top);
        const collapsedScrollHeight = await section.evaluate(node => node.scrollHeight);
        layoutMetrics.push({ width, locale, workspaceTopPx: Math.round(y), collapsedScrollHeightPx: collapsedScrollHeight, pathCountPerCategory: 65, totalPathCount: 195 });
        assert.ok(y < 520, `workspace heading should be near the first viewport, was ${y}px`);
        const summaries = page.locator(".settings-permission-paths");
        assert.equal(await summaries.count(), 3);
        assert.equal(await page.locator(".settings-permission-paths[open]").count(), 0, "all policy disclosures start collapsed");
        assert.equal(await page.locator(".settings-permission-paths .settings-code-list code:visible").count(), 0, "collapsed policy paths are not visible");
        assert.ok(await section.locator(".settings-about-row button").count() > 0, "workspace copy buttons remain available");
        const assistantWorkspace = section.locator(".settings-about-row").filter({ hasText: "/workspace/raytone/assistant" });
        await assistantWorkspace.locator("button.settings-copy").click();
        await page.waitForFunction(async () => await navigator.clipboard.readText() === "/workspace/raytone/assistant");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "/workspace/raytone/assistant", "copy control writes the workspace path to the clipboard");
        assert.equal(await assistantWorkspace.locator("button.settings-copy").getAttribute("aria-label"), locale === "en" ? "Copied" : locale === "zh" ? "已复制" : "コピーしました");
        if (process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS && locale === "en") {
          mkdirSync(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, `permission-layout-${width}-collapsed.png`) });
        }
        for (let i = 0; i < 3; i++) {
          const details = summaries.nth(i);
          const summary = details.locator("summary");
          await summary.focus();
          await page.keyboard.press("Enter");
          assert.equal(await details.locator(".settings-code-list code").count(), 65);
          assert.equal(await details.locator(".settings-code-list").isVisible(), true);
          if (i === 0 && process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS && locale === "en") {
            await page.screenshot({ path: join(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, `permission-layout-${width}-expanded.png`) });
          }
          await page.keyboard.press("Space");
          assert.equal(await details.locator(".settings-code-list").isVisible(), false);
          assert.equal(await details.locator(".settings-code-list code:visible").count(), 0, "Space closes and hides the path list");
        }
        for (const title of [labels.secret, labels.protected, labels.readOnly]) {
          assert.equal(await page.getByRole("heading", { name: title }).count(), 1, `${title} remains visible outside the disclosure`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "long paths must not create horizontal overflow");
      } finally { await page.close(); }
    });
    if (process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS) {
      writeFileSync(join(process.env.RAYTONEBOT_PERMISSION_SCREENSHOTS, "permission-layout-metrics.json"), `${JSON.stringify(layoutMetrics, null, 2)}\n`);
    }
    await t.test("network failure preserves authorization, retry works, and unmounting during pending is safe", async () => {
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(30_000);
      let release!: (route: Route) => void;
      const delayed = new Promise<Route>(resolve => { release = resolve; });
      let posts = 0;
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/__agentcanvas/pi/approvals/clear", async route => {
        posts++;
        if (posts === 1) return route.abort("failed");
        if (posts === 2) return route.fulfill({ status: 200, contentType: "application/json", body: '{"alwaysAllowed":{"planner":["search"]}}' });
        release(route);
      });
      try {
        await page.goto(`${base}permission-feedback-test`, { waitUntil: "domcontentloaded" });
        let row = page.locator(".settings-list .settings-row").filter({ hasText: "read_file" });
        await page.getByRole("button", { name: "Reset", exact: true }).first().click();
        await row.getByRole("alert").getByText("Could not confirm the reset. Try again.", { exact: true }).waitFor();
        assert.equal(await row.getByText("read_file", { exact: true }).count(), 1, "network failure retains grant");
        await row.getByRole("button", { name: "Try again", exact: true }).click();
        await row.waitFor({ state: "detached" });
        assert.equal(posts, 2);
        await page.reload();
        row = page.locator(".settings-list .settings-row").filter({ hasText: "read_file" });
        await page.getByRole("button", { name: "Reset", exact: true }).first().click();
        await page.getByRole("status").waitFor();
        await page.getByRole("button", { name: "Unmount" }).click();
        await (await delayed).abort("failed");
        await page.getByText("Unmounted").waitFor();
        assert.equal(posts, 3);
        assert.deepEqual(errors, []);
        assert.equal(await page.locator("[role=alert]").count(), 0);
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
