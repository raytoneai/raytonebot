import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { observerText } from "../i18n/copy/observer.ts";

test("follow-up owner saves typed references, keeps conflict drafts, and clears deleted or revoked private text in three locales", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-follow-up-ui-"));
  const initial = { id: "finding-test", revision: 7, title: "User finding", validity: "stale" };
  const source = (id: string, title: string) => ({ source: { instanceId: "instance", conversationId: id, generation: "g1" }, version: "a".repeat(64), conversationTitle: title, botId: "assistant", harness: "pi", model: { provider: "actual", model: "actual-model" }, contextFreshness: "unknown", runId: `run-${id}`, at: 1000, status: "success" });
  const sources = [source("baseline-chat", "Baseline task"), source("candidate-chat", "Candidate task")];
  const server = await createServer({ configFile: false, cacheDir, server: { host: "127.0.0.1", port: 0, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] }, plugins: [{ name: "follow-up-test", configureServer(vite) {
    vite.middlewares.use("/follow-up-test", async (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(await vite.transformIndexHtml("/follow-up-test", `<div id="root"></div><script type="module">
        import {createElement as h,useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {ObserverFollowUp} from '/src/components/settings/ObserverFollowUp.tsx'; import {LocaleProvider} from '/src/i18n/LocaleContext.tsx';
        import '/src/components/settings/settings.css';
        const locale=new URLSearchParams(location.search).get('locale')||'en';
        function Probe(){ const [finding,setFinding]=useState(${JSON.stringify(initial)});const [visible,setVisible]=useState(true);
          window.setFinding=next=>setFinding({...${JSON.stringify(initial)},...next});
          return h(LocaleProvider,{initialLocale:locale},h('section',{'data-observer-settings':true},h('button',{onClick:()=>setVisible(false)},'Revoke'),visible?h(ObserverFollowUp,{finding,refresh:()=>{},onOpenConversation:(id,target)=>window.openedSource={id,target}}):null)); }
        createRoot(document.getElementById('root')).render(h(Probe));
      </script>`));
    });
  } }] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen(); browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    const evidenceDir = process.env.RAYTONEBOT_OBSERVER_UI_EVIDENCE;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    for (const locale of ["en", "zh", "ja"] as const) {
      const page = await browser.newPage({ viewport: { width: locale === "en" ? 1280 : 390, height: 900 } });
      const t = (key: Parameters<typeof observerText>[1]) => observerText(locale, key);
      const writes: any[] = []; let followUp: any; let conflict = true; let delayed: Route | undefined;
      const provenance = { findingRevision: 7, recordedAt: 2000, requestedBy: "user_session", authorizedVia: "audit-only", verification: "user_recorded" };
      const withMetadata = (ref: any) => ({ ...ref, harness: "pi", model: { provider: "actual", model: "actual-model" }, contextFreshness: "unknown" });
      await page.route("**/__agentcanvas/pi/observer**", async route => {
        if (route.request().url().includes("/follow-up-sources")) return route.fulfill({ json: { sources } });
        if (route.request().method() === "GET") return route.fulfill({ json: { findings: [{ ...initial, followUp }] } });
        const body = route.request().postDataJSON(); writes.push(body);
        if (body.action === "record_implementation") {
          if (body.implementation.summary === "Late private write") { delayed = route; return; }
          followUp = { ...followUp, revision: (followUp?.revision ?? 0) + 1, implementation: { ...body.implementation, references: body.implementation.references.map(withMetadata), ...provenance } };
        } else if (conflict) {
          conflict = false; followUp = { ...followUp, revision: 2, implementation: { ...followUp.implementation, summary: "Changed remotely" } };
          return route.fulfill({ status: 409, json: { code: "observer_follow_up_conflict" } });
        } else followUp = { ...followUp, revision: 3, effect: { ...body.effect, baseline: body.effect.baseline.map(withMetadata), candidate: body.effect.candidate.map(withMetadata), ...provenance } };
        return route.fulfill({ json: { followUp } });
      });
      await page.goto(`${base}follow-up-test?locale=${locale}`);
      await page.locator('[data-observer-follow-up] > summary').click();
      const implementation = page.locator('[data-observer-implementation]'), effect = page.locator('[data-observer-effect]');
      await implementation.getByRole('combobox').selectOption('implemented');
      await implementation.getByRole('textbox').fill('Implemented with an actual source');
      await page.waitForFunction(() => document.querySelectorAll('option').length > 12);
      const baselineValue = await implementation.getByRole('listbox').locator('option', { hasText: 'Baseline task' }).getAttribute('value');
      const candidateValue = await implementation.getByRole('listbox').locator('option', { hasText: 'Candidate task' }).getAttribute('value');
      assert.ok(baselineValue); assert.ok(candidateValue);
      await implementation.getByRole('listbox').selectOption(baselineValue);
      await implementation.getByRole('button', { name: t('saveImplementation'), exact: true }).click();
      await page.getByRole('status').filter({ hasText: t('followUpSaved') }).waitFor();
      assert.equal(writes[0].revision, 7); assert.equal(writes[0].followUpRevision, 0);
      assert.deepEqual(Object.keys(writes[0].implementation.references[0]).sort(), ['kind','runId','source','version']);
      await implementation.getByRole('button', { name: t('openSource'), exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as any).openedSource), { id: 'baseline-chat', target: { runId: 'run-baseline-chat' } });
      await effect.getByRole('combobox').selectOption('improved');
      await effect.getByRole('textbox', { name: `${t('effectSummary')} · User finding`, exact: true }).fill('Local outcome draft');
      await effect.getByRole('textbox', { name: `${t('successCriteria')} · User finding`, exact: true }).fill('Same task with fewer observed errors');
      await effect.getByRole('listbox', { name: `${t('baseline')} · User finding`, exact: true }).selectOption(baselineValue);
      await effect.getByRole('listbox', { name: `${t('candidate')} · User finding`, exact: true }).selectOption(baselineValue);
      assert.equal(await effect.getByRole('button', { name: t('saveEffect'), exact: true }).isDisabled(), true);
      await effect.getByRole('listbox', { name: `${t('candidate')} · User finding`, exact: true }).selectOption(candidateValue);
      await effect.getByRole('spinbutton').fill('3');
      await effect.getByRole('textbox', { name: `${t('recordedCost')} · User finding`, exact: true }).fill('Supplier usage unknown');
      await effect.getByRole('button', { name: t('saveEffect'), exact: true }).click();
      await page.getByRole('button', { name: t('loadLatest'), exact: true }).click();
      assert.equal(await effect.getByRole('textbox', { name: `${t('effectSummary')} · User finding`, exact: true }).inputValue(), 'Local outcome draft');
      await page.locator('[data-observer-saved-follow-up]').getByText('Changed remotely', { exact: false }).waitFor();
      await effect.getByRole('button', { name: t('saveEffect'), exact: true }).click();
      await page.getByRole('status').filter({ hasText: t('followUpSaved') }).waitFor();
      assert.equal(writes.at(-1).followUpRevision, 2); assert.equal(writes.at(-1).effect.sampleSize, 3);
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `follow-up-owner-${locale}.png`), fullPage: true });
      await implementation.getByRole('textbox').fill('Keep this unrelated implementation draft');
      await effect.getByRole('textbox', { name: `${t('effectSummary')} · User finding`, exact: true }).fill('Private deleted-source outcome draft');
      const cleared = { ...followUp, revision: 4, effect: undefined, clearedSections: ['effect'], clearedAt: 1000 };
      await page.evaluate(record => (window as any).setFinding({ followUp: record }), cleared);
      await page.getByRole('status').filter({ hasText: t('sourceCleared') }).waitFor();
      assert.equal(await effect.getByRole('textbox', { name: `${t('effectSummary')} · User finding`, exact: true }).inputValue(), '');
      assert.equal(await implementation.getByRole('textbox').inputValue(), 'Keep this unrelated implementation draft');
      assert.equal(await page.locator('body').evaluate(body => body.scrollWidth > innerWidth), false);
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `follow-up-source-cleared-${locale}.png`), fullPage: true });
      await page.getByRole('button', { name: t('discardFollowUp'), exact: true }).click();
      await implementation.getByRole('textbox').fill('Late private write');
      await implementation.getByRole('button', { name: t('saveImplementation'), exact: true }).click();
      for (let i=0; !delayed && i<100; i++) await page.waitForTimeout(10);
      assert.ok(delayed);
      await page.getByRole('button', { name: 'Revoke', exact: true }).click();
      await delayed.fulfill({ json: { followUp } });
      await page.waitForTimeout(30);
      assert.equal(await page.locator('[data-observer-follow-up]').count(), 0);
      assert.equal(await page.locator('body').innerText(), 'Revoke');
      assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0);
      await page.close();
    }
  } finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
