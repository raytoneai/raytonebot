import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { observerText } from "../i18n/copy/observer.ts";

test("Observer owner renders in three locales, keeps evidence temporary, and clears late private reads", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 45_000 }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-observer-ui-"));
  const finding = { id: "finding-test", revision: 1, title: "Test finding", kind: "project_suggestion", analysisLevel: "L2", requestedBy: "user_session", observerRunId: "run-test", instanceId: "instance", reviewStatus: "accepted", validity: "current", facts: [{ id: "fact-test", kind: "failure", value: { count: 1 }, evidenceIds: ["ref-test"] }], factIds: ["fact-test"], evidenceRefs: [{ id: "ref-test" }], inference: "Possible explanation", proposedAction: { kind: "add_test", target: { kind: "code", id: "src/example.ts" }, description: "Add a check", verificationRefs: ["ref-test"] }, scope: [{ instanceId: "instance", conversationId: "chat", generation: "1" }], model: { provider: "configured", model: "model", configRevision: "1" }, buildStamp: { buildId: "test", manifestHash: "hash" }, budgetSpent: { unknownUsage: 1 } };
  const state = { finishedWithoutFindings: 2, l2Available: true, revision: 1, enabled: true, backgroundEnabled: false, windowDays: 7, model: { provider: "configured", model: "model", configRevision: "1", available: true }, models: [{ provider: "configured", model: "model", label: "Configured model", available: true, configRevision: "1" }], budgets: { dailyRequests: 10, maxRequests: 6, maxDurationMs: 120000, maxQueries: 20, maxBytes: 262144, pageBytes: 32768, pageSize: 100 }, usage: { day: "2026-11-02", calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 1 }, runState: { running: false }, findings: [finding] };
  const server = await createServer({ configFile: false, cacheDir, server: { host: "127.0.0.1", port: 0, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] }, plugins: [{ name: "observer-ui-test", configureServer(vite) {
    vite.middlewares.use("/observer-ui-test", async (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(await vite.transformIndexHtml("/observer-ui-test", `<div id="root"></div><script type="module">
        import {createElement as h,useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {ObserverSection} from '/src/components/settings/ObserverSection.tsx';
        import {LocaleProvider} from '/src/i18n/LocaleContext.tsx'; import {useObserver} from '/src/runtime/useObserver.ts';
        const locale=new URLSearchParams(location.search).get('locale')||'en'; window.actions=[];
        function Probe(){ const [active,setActive]=useState(true); const hook=useObserver(active);
          return h('main',null,h('button',{onClick:()=>setActive(false)},'Revoke'),h('pre',{id:'hook-state'},JSON.stringify(hook.state))); }
        const observer={state:{...${JSON.stringify(state)},l2Available:!new URLSearchParams(location.search).has("l2blocked")},busy:false,error:false,refresh:async()=>{},update:async action=>{window.actions.push(action);return {}}};
        createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('hook')?h(Probe):h(LocaleProvider,{initialLocale:locale},h(ObserverSection,{observer,bots:[{id:'assistant',presetId:'assistant',name:'Test Bot',appearance:{}}],onOpenChat:()=>{window.chatOpened=true},onOpenOutput:item=>{window.openedItem=item},onHandoff:()=>{}})));
      </script>`));
    });
  } }] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen(); browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    for (const locale of ["en", "zh", "ja"] as const) {
      const page = await browser.newPage();
      await page.route("**/__agentcanvas/pi/observer/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().url().includes("/evidence?") ? { title: "source.html", language: "html", text: "<script>unsafe()</script>", sourceLabel: "src/source.html:1", validity: "current", readOnly: true } : finding) }));
      await page.goto(`${base}observer-ui-test?locale=${locale}`);
      await page.getByRole("button", { name: observerText(locale, "details"), exact: true }).click();
      await page.waitForFunction(() => Boolean((window as any).openedItem));
      const report = await page.evaluate(() => (window as any).openedItem);
      assert.equal(report.ephemeral, true); assert.match(report.body, /fact-test/);
      await page.getByRole("button", { name: `${observerText(locale, "evidence")} · ref-test`, exact: true }).click();
      await page.waitForFunction(() => (window as any).openedItem?.kind === 'review');
      const evidence = await page.evaluate(() => (window as any).openedItem);
      assert.equal(evidence.ephemeral, true); assert.equal(evidence.downloadUrl, undefined);
      await page.getByRole("button", { name: observerText(locale, "chat"), exact: true }).click();
      assert.equal(await page.evaluate(() => (window as any).chatOpened), true);
      await page.getByRole("button", { name: observerText(locale, "analyze"), exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as any).actions), [{ action: "analyze" }]);
      await page.getByRole("spinbutton", { name: observerText(locale, "windowDays"), exact: true }).fill("14");
      await page.getByRole("button", { name: observerText(locale, "save"), exact: true }).click();
      const settings = await page.evaluate(() => (window as any).actions.at(-1));
      assert.equal(settings.action, "settings"); assert.equal(settings.windowDays, 14); assert.equal(settings.backgroundEnabled, false);
      await page.locator("[data-observer-clear-runs]").click();
      assert.deepEqual(await page.evaluate(() => (window as any).actions.at(-1)), { action: "clear_finished_runs" });
      await page.close();
    }
    const blocked = await browser.newPage();
    await blocked.goto(`${base}observer-ui-test?l2blocked=1`);
    assert.equal(await blocked.getByRole("button", { name: observerText("en", "chat"), exact: true }).isDisabled(), true);
    assert.equal(await blocked.getByRole("button", { name: observerText("en", "analyze"), exact: true }).isDisabled(), false);
    await blocked.close();
    const page = await browser.newPage();
    let pending: import("playwright-core").Route | undefined;
    await page.route("**/__agentcanvas/pi/observer", route => { pending = route; });
    await page.goto(`${base}observer-ui-test?hook=1`);
    await page.waitForFunction(() => document.querySelector('#hook-state') !== null);
    for (let count = 0; !pending && count < 100; count++) await page.waitForTimeout(10);
    assert.ok(pending);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await pending.fulfill({ contentType: "application/json", body: JSON.stringify(state) });
    await page.waitForTimeout(30);
    assert.equal(await page.locator("#hook-state").textContent(), "", "late private response cannot restore evidence after scope is removed");
    await page.close();
  } finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
