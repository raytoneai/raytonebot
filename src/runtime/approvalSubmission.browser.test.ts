import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("approval stays a decision while the connection is reconciled", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-approval-test-"));
  const server = await createServer({ configFile: false, cacheDir, server: { host: "127.0.0.1", port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "approval-test-page", configureServer(vite) {
      vite.middlewares.use("/approval-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/approval-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { InlineApprovalPrompt, InlineApprovalSurface, ExternalApprovalSurface } from '/src/components/agent-preview/chatframe/approval.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { submitPiApproval } from '/src/pi/piClient.ts';
          import '/src/styles/app.css';
          const params = new URLSearchParams(location.search);
          function Probe() {
            const [settled, setSettled] = useState(false);
            const [selected, setSelected] = useState('saved');
            if (params.has('form')) return settled ? h('p', null, 'Submitted: ' + selected) : h(InlineApprovalPrompt, {
              ariaLabel: 'Saved login', kicker: 'Login', question: 'Choose a login', singleChoice: true,
              options: ['saved', 'other'].map(id => ({ id, title: id, selected: selected === id, onSelect: () => setSelected(id) })),
              primaryLabel: 'Fill login', onPrimary: () => setSettled(true),
            });
            return settled ? h('p', null, 'Closed') : h('div', { className: 'preview-frame', style: { padding: '16px', display: 'block' } },
              h(params.get('surface') === 'external' ? ExternalApprovalSurface : InlineApprovalSurface, {
                tool: { id: 'tool', name: 'write', title: 'notes.md', approval: { argsPreview: { path: 'notes.md' } } },
                onConfirm: async (decision, signal) => {
                  await submitPiApproval({toolCallId:'tool', decision, conversationId:'conversation', runId:'run'}, {signal});
                  setSettled(true);
                }
              }));
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: params.get('locale') || 'zh' }, h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    for (const [locale, confirm, syncing] of [
      ["zh", "确认", "正在确认你的选择"],
      ["en", "Confirm", "Confirming your choice"],
      ["ja", "確定", "選択を確認しています"],
    ]) for (const surface of ["inline", "external"]) {
      await t.test(`${locale} ${surface}: one decision survives a lost receipt`, async () => {
        const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
        const requests: unknown[] = [];
        let received!: (route: Route) => void;
        const statusRead = new Promise<Route>(resolve => { received = resolve; });
        await page.route("**/__agentcanvas/pi/approval**", route => {
          if (route.request().method() === "GET") { received(route); return; }
          requests.push(route.request().postDataJSON());
          return requests.length === 1 ? route.abort("failed")
            : route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
        });
        try {
          await page.goto(`${server.resolvedUrls!.local[0]}approval-test?surface=${surface}&locale=${locale}`);
          assert.equal(requests.length, 0, "waiting for a person never sends a decision");
          if (process.env.RAYTONEBOT_APPROVAL_SCREENSHOT_DIR && locale === "zh") {
            mkdirSync(process.env.RAYTONEBOT_APPROVAL_SCREENSHOT_DIR, { recursive: true });
            await page.locator("[data-approval-surface]").screenshot({ path: join(process.env.RAYTONEBOT_APPROVAL_SCREENSHOT_DIR, `${surface}-waiting.png`) });
          }
          assert.equal(await page.getByRole("button", { name: confirm, exact: true }).count(), 0);
          assert.equal(await page.getByRole("radio").count(), 0);
          await page.locator('[data-approval-surface]').evaluate(panel => {
            (panel.querySelector('[data-approval-action="no"]') as HTMLButtonElement).click();
            (panel.querySelector('[data-approval-action="always"]') as HTMLButtonElement).click();
          });
          const status = await statusRead;
          await page.getByRole("status").filter({ hasText: syncing }).waitFor();
          for (const action of ["yes", "always", "no"]) assert.equal(await page.locator(`[data-approval-action="${action}"]`).isDisabled(), true);
          assert.equal(await page.locator('[data-approval-action="no"]').getAttribute("data-selected"), "true");
          assert.notEqual(await page.locator('[data-approval-action="always"]').getAttribute("data-selected"), "true");
          assert.equal(await page.getByRole("button", { name: /重试|刷新|Retry|Reload|再試行|再読み込み/ }).count(), 0);
          assert.equal(await page.locator("details").count(), 0);
          assert.equal(requests.length, 1, "a lost receipt is checked before another POST");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          // Already answered elsewhere closes without resending. Still waiting permits delivery
          // of the same decision, never another human approval choice or another tool execution.
          await status.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pending: surface === "inline" }) });
          await page.getByText("Closed", { exact: true }).waitFor();
          assert.deepEqual(requests, Array(surface === "inline" ? 2 : 1).fill({ toolCallId: "tool", decision: "no", conversationId: "conversation", runId: "run" }));
        } finally { await page.close(); }
      });
    }
    for (const surface of ["inline", "external"]) {
      await t.test(`${surface}: each action submits directly, focus alone never approves`, async () => {
        const page = await browser!.newPage();
        const requests: { decision: string }[] = [];
        await page.route("**/__agentcanvas/pi/approval**", route => {
          requests.push(route.request().postDataJSON());
          return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
        });
        try {
          for (const [index, action] of ["yes", "always", "no"].entries()) {
            await page.goto(`${server.resolvedUrls!.local[0]}approval-test?surface=${surface}`);
            await page.locator('[data-approval-action="yes"]').waitFor();
            assert.equal(await page.locator('[data-selected="true"]').count(), 0, "no preselected permission");
            for (let tab = 0; tab <= index; tab++) await page.keyboard.press("Tab");
            assert.equal(await page.locator(":focus").getAttribute("data-approval-action"), action);
            assert.equal(requests.length, index, "focus does not submit");
            if (action === "no") await page.locator('[data-approval-action="no"]').click();
            else await page.keyboard.press(action === "yes" ? "Enter" : "Space");
            await page.getByText("Closed", { exact: true }).waitFor();
            assert.deepEqual(requests.map(request => request.decision), ["yes", "always", "no"].slice(0, index + 1));
          }
        } finally { await page.close(); }
      });
    }
    await t.test("shared form choices still require their submit button", async () => {
      const page = await browser!.newPage();
      try {
        await page.goto(`${server.resolvedUrls!.local[0]}approval-test?form=1`);
        await page.getByRole("radio", { name: "other", exact: true }).check();
        assert.equal(await page.getByRole("radio", { name: "other", exact: true }).isChecked(), true);
        assert.equal(await page.getByText("Submitted: other", { exact: true }).count(), 0);
        await page.getByRole("button", { name: "Fill login", exact: true }).click();
        await page.getByText("Submitted: other", { exact: true }).waitFor();
      } finally { await page.close(); }
    });
    await t.test("refresh cancels reconciliation without sending a new decision", async () => {
      const page = await browser!.newPage();
      let posts = 0, read!: () => void;
      const reading = new Promise<void>(resolve => { read = resolve; });
      await page.route("**/__agentcanvas/pi/approval**", route => {
        if (route.request().method() === "GET") { read(); return; }
        posts++;
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Unavailable"}' });
      });
      try {
        await page.goto(`${server.resolvedUrls!.local[0]}approval-test`);
        await page.locator('[data-approval-action="yes"]').click();
        await reading;
        await page.reload();
        await page.locator('[data-approval-action="yes"]').waitFor();
        assert.equal(posts, 1);
        assert.equal(await page.locator('[data-approval-action="yes"]').isEnabled(), true);
        assert.doesNotMatch(await page.locator("body").innerText(), /服务|失败|重试/);
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
