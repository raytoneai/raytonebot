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
test("routine controls preserve navigation and distinguish waiting, model reports and host status in three locales", {
  skip: !findHeadlessShell() && "Chromium not installed",
  timeout: 120_000,
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
              import { useRoutines } from '/src/runtime/useRoutines.ts';
              import { RoutinesSection } from '/src/components/settings/RoutinesSection.tsx';
              import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
              import '/src/styles/app.css';
              import '/src/components/settings/settings.css';

              const conversationId = 'routine-conversation-browser';
              const baseRun = { at: 1_700_000_000_000, status: 'error', occurrenceId: 'failed-now', error: 'Provider rejected configuration.' };
              const oldSuccess = { at: 1_699_999_000_000, status: 'success', occurrenceId: 'accepted-before', runId: 'routine_run_before', textId: 'text-before' };
              const now = Date.now();
              const report = { status: 'no_changes', summary: 'The model found no changes. ' + 'LongUnbrokenSummary'.repeat(25), evidence: [{ label: 'Model supplied source', reference: 'https://example.com/' + 'LongUnbrokenReference'.repeat(30) }], reportedAt: now - 60000 };
              const waitingRun = { ...oldSuccess, occurrenceId: 'waiting-now', status: 'running', waiting: true, at: now - 2100000,
                waitingDetails: { reasons: ['approval', 'question', 'vault', 'channel_setup'], count: 4, since: now - 2100000 } };
              const reportedFailure = { ...oldSuccess, occurrenceId: 'reported-failure', status: 'error', waiting: true,
                waitingDetails: waitingRun.waitingDetails, error: 'Host failed after the model report.', report };
              const scenarios = {
                waiting: { lastRun: waitingRun, history: [waitingRun] },
                unknown: { lastRun: { ...waitingRun, waitingDetails: { reasons: ['approval'], count: 1 } }, history: [{ ...waitingRun, waitingDetails: { reasons: ['approval'], count: 1 } }] },
                reportedFailure: { lastRun: reportedFailure, history: [reportedFailure, { ...oldSuccess, status: 'cancelled', occurrenceId: 'reported-cancelled', report }, { ...oldSuccess, status: 'interrupted', occurrenceId: 'reported-interrupted', report: { ...report, status: 'blocked' } }, { ...oldSuccess, occurrenceId: 'reported-changes', report: { ...report, status: 'changes' } }] },
                never: { history: [] },
                failed: { lastRun: baseRun, history: [baseRun] },
                recovered: { lastRun: baseRun, history: [baseRun, oldSuccess] },
                running: { lastRun: { ...oldSuccess, occurrenceId: 'running-now', status: 'running', at: 1_700_000_100_000 }, history: [{ ...oldSuccess, occurrenceId: 'running-now', status: 'running', at: 1_700_000_100_000 }] },
                finished: { lastRun: oldSuccess, history: [oldSuccess] },
              };

              function Probe() {
                const params = new URLSearchParams(location.search);
                const scenario = params.get('scenario') || 'failed';
                const locale = params.get('locale') || 'en';
                const live = useRoutines(params.has('poll'));
                const [opened, setOpened] = useState('');
                const selected = scenarios[scenario] || scenarios.failed;
                const routine = { id: 'routine-browser', botId: 'assistant', title: 'Morning report', schedule: '0 9 * * 1-5', timezone: 'Asia/Shanghai', instructions: 'Check the morning report.', enabled: true, createdAt: 1_699_000_000_000, revision: 1, conversationId, failures: 0, ...selected };
                window.__routineFixture = window.__routineFixture || routine;
                const fixedState = { routines: [routine], setEnabled: async () => {}, runNow: async () => {}, remove: async () => {}, update: async () => true };
                const state = params.has('poll') ? live : fixedState;
                const open = (id, target) => setOpened(JSON.stringify({ id, target: target?.runId || target?.textId || '' }));
                return h(ShellExtrasProvider, { value: {} },
                  h('main', { className: 'settings-dialog', 'data-scenario': scenario, style: { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' } },
                    h('div', { className: 'settings-body' },
                      h('div', { className: 'settings-body-scroll' },
                        h(RoutinesSection, { t: settingsCopy[locale], state, onOpenConversation: open, drafts: {}, onDraft: () => {} }),
                        opened ? h('output', { 'data-opened-conversation': opened }) : null))));
              }
              createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: new URLSearchParams(location.search).get('locale') || 'en' }, h(Probe)));
            </script>`));
        });
      },
    }],
  });
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls!.local[0];
    for (const scenario of ["never", "failed", "recovered", "running", "finished"]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${baseUrl}routine-controls-test?scenario=${scenario}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        const openConversation = page.getByRole("button", { name: "Open conversation", exact: true });
        if (scenario === "failed" || scenario === "never") {
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
        if (scenario === "never") {
          assert.equal(await page.locator(".routine-run-report, .routine-run-summary").count(), 0);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${scenario} fits a 390px viewport`);
        if (process.env.RAYTONEBOT_ROUTINE_SCREENSHOT) {
          const dir = join(process.cwd(), "output/dsh-review-fixes-2026-11-02/batch3-visual");
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: join(dir, `routine-${scenario}-mobile.png`), fullPage: false });
        }
      } finally { await page.close(); }
    }
    const { settingsCopy } = await import("../i18n/copy/settings.ts");
    const { featureText } = await import("../i18n/copy/features.ts");
    const screenshotDir = join(process.cwd(), "output/dsh-review-fixes-2026-11-02/batch3-visual");
    for (const locale of ["en", "zh", "ja"] as const) for (const width of [1200, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const c = settingsCopy[locale].routines;
      const fit = async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator(".settings-body-scroll").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${locale}/${width} has no inner horizontal overflow`);
      };
      const screenshot = async (name: string) => {
        if (!process.env.RAYTONEBOT_ROUTINE_SCREENSHOT) return;
        mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `${locale}-${width}-${name}.png`) });
      };
      try {
        await page.route("**/__agentcanvas/pi/routines", async route => {
          const routine = await page.evaluate(() => (window as unknown as { __routineFixture: unknown }).__routineFixture);
          await route.fulfill({ json: { routines: [routine] } });
        });
        await page.goto(`${baseUrl}routine-controls-test?scenario=waiting&locale=${locale}&poll=1`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        const summary = page.locator(".routine-run-summary");
        for (const reason of ["Approval", "Answer", "Secure input", "Channel setup"] as const) assert.ok((await summary.innerText()).includes(featureText(locale, reason)));
        assert.ok((await summary.innerText()).includes(featureText(locale, "Pending: {count}", { count: 4 })));
        assert.ok((await summary.innerText()).includes(c.openConversation), "a long wait reminds the user even while collapsed");
        assert.ok((await summary.innerText()).includes(featureText(locale, "Waiting {minutes} min", { minutes: 35 })));
        assert.equal(await page.locator(".routine-waiting-details").getByText(featureText(locale, "Waiting 30 minutes or more. Open the conversation to continue."), { exact: true }).count(), 1);
        await fit(); await screenshot("waiting");
        await page.evaluate(() => {
          const fixture = (window as unknown as { __routineFixture: { lastRun: Record<string, unknown>; history: unknown[] } }).__routineFixture;
          fixture.lastRun = { ...fixture.lastRun, waiting: false, waitingDetails: undefined };
          fixture.history = [fixture.lastRun];
        });
        // The production hook's existing three-second poll must remove stale waiting state.
        await page.waitForFunction(() => !document.querySelector(".routine-run-summary[data-waiting]"), undefined, { timeout: 6000 });
        assert.equal(await page.locator(".routine-waiting-details").count(), 0);
        assert.equal(await page.locator(".routine-row-header .settings-key-pill").innerText(), c.status.running);
        assert.ok((await summary.innerText()).includes(featureText(locale, "No model report")));
        await screenshot("released");
        await page.goto(`${baseUrl}routine-controls-test?scenario=unknown&locale=${locale}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        assert.ok((await page.locator(".routine-run-summary").innerText()).includes(featureText(locale, "Wait time unknown")));
        assert.equal(await page.getByText(featureText(locale, "Waiting 30 minutes or more. Open the conversation to continue."), { exact: true }).count(), 0);
        await fit(); await screenshot("unknown");
        await page.goto(`${baseUrl}routine-controls-test?scenario=reportedFailure&locale=${locale}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        assert.equal(await page.locator(".routine-row-header .settings-key-pill").innerText(), c.status.error);
        assert.ok((await page.locator(".routine-run-report").innerText()).includes(`${featureText(locale, "Model reported")}: ${featureText(locale, "No changes")}`));
        assert.ok((await page.locator(".routine-run-report").innerText()).includes(featureText(locale, "Model self-report; listed evidence is not verified by the host.")));
        assert.equal(await page.locator(".routine-waiting-details").count(), 0, "terminal failure never becomes waiting because of stale fields");
        assert.equal(await page.locator(".routine-run-report a, .routine-evidence a").count(), 0, "model evidence remains plain text");
        await fit(); await screenshot("reported-failure");
        const historyStatus = await page.locator(".routine-history .settings-key-pill").allInnerTexts();
        assert.deepEqual(historyStatus, [c.status.error, c.status.cancelled, c.status.interrupted, c.status.success]);
        assert.ok((await page.locator(".routine-history").innerText()).includes(featureText(locale, "Blocked")));
        assert.ok((await page.locator(".routine-history").innerText()).includes(featureText(locale, "Changes")));
        await page.locator(".settings-body-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
        await screenshot("history");
        await page.getByRole("button", { name: featureText(locale, "View result"), exact: true }).first().click();
        assert.deepEqual(JSON.parse(await page.locator("[data-opened-conversation]").getAttribute("data-opened-conversation") ?? "{}"), { id: "routine-conversation-browser", target: "routine_run_before" });
        await page.goto(`${baseUrl}routine-controls-test?scenario=finished&locale=${locale}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Morning report", exact: true }).click();
        assert.ok((await page.locator(".routine-run-summary").innerText()).includes(featureText(locale, "No model report")));
        assert.ok((await page.locator(".routine-history").innerText()).includes(featureText(locale, "No model report")));
        assert.equal(await page.locator(".routine-row-header .settings-key-pill").innerText(), c.status.success);
        await fit(); await screenshot("unreported");
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
