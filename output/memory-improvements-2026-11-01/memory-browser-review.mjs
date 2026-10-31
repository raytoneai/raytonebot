import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findHeadlessShell } from '../../src/pi/browser/browserService.ts';

const output = new URL('.', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'raytone-memory-ui-'));
process.env.RAYTONEBOT_DATA_DIR = join(root, 'data');
process.env.RAYTONEBOT_WORKSPACE_ROOT = join(root, 'workspace');
process.env.RAYTONEBOT_VAULT_DIR = join(root, 'vault');
process.env.RAYTONEBOT_SANDBOX = '0';
const { createServer } = await import('vite');
const server = await createServer({ server: { port: 0, strictPort: true, host: '127.0.0.1', hmr: false, ws: false } });
let browser;
const report = { scenarios: [], pageErrors: [], screenshots: [] };
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const api = async (path = '', body) => {
    const response = await fetch(`${origin}/__agentcanvas/pi/memories${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  };
  const original = (await api('', { text: 'Project reference remains available.', evidence: { url: 'https://example.com/reference', checkedAt: '2026-10-31' } })).memory;
  browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('agentcanvas.locale', 'en'));
  await page.goto(origin);
  await page.locator('.shell-footer-button').click();
  await page.locator('.settings-rail-item').filter({ hasText: /^Memory$/ }).click();
  const body = page.locator('.settings-body');
  let row = body.locator('.settings-memory-row').filter({ hasText: original.text });
  await row.getByRole('link', { name: 'Source · example.com' }).waitFor();
  assert.match(await row.innerText(), /Recorded check date: 2026-10-31/);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editing = body.locator('.settings-memory-row').filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  await editing.getByLabel('Edit', { exact: true }).fill('My unsubmitted revision.');
  await editing.getByText('Source details (optional)', { exact: true }).click();
  await editing.getByLabel('Source URL', { exact: true }).fill('https://example.com/new-source');
  const nextPoll = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/memories'));
  await api(`/${original.id}`, { text: 'Concurrent revision must survive.', expectedText: original.text });
  await nextPoll;
  const conflict = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/memories/${original.id}`));
  await editing.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  assert.equal(await editing.getByLabel('Edit', { exact: true }).inputValue(), 'My unsubmitted revision.');
  assert.equal((await api()).memories[0].text, 'Concurrent revision must survive.');
  await editing.getByRole('button', { name: 'Cancel', exact: true }).click();
  report.scenarios.push('live-poll-stale-edit-rejected-draft-preserved');

  await body.getByLabel('Add something to remember…', { exact: true }).fill('Use the official source for current availability.');
  const details = body.locator('details').last();
  await details.locator('summary').click();
  await details.getByLabel('Source URL', { exact: true }).fill('https://example.com/current');
  assert.equal(await details.getByLabel('Recorded check date (optional)', { exact: true }).inputValue(), '');
  await details.getByLabel('Recorded check date (optional)', { exact: true }).fill('2026-11-01');
  const added = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/memories'));
  await body.getByRole('button', { name: 'Add', exact: true }).click();
  assert.equal((await added).status(), 201);
  row = body.locator('.settings-memory-row').filter({ hasText: 'Use the official source' });
  await row.getByRole('link').waitFor();
  assert.match(await row.innerText(), /Recorded check date: 2026-11-01/);
  assert.equal(await details.getByLabel('Source URL', { exact: true }).inputValue(), '');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await editing.locator('summary').click();
  await editing.getByLabel('Source URL', { exact: true }).fill('');
  const cleared = page.waitForResponse(response => response.request().method() === 'POST' && /\/memories\/m/.test(response.url()));
  await editing.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await cleared).status(), 200);
  assert.equal((await api()).memories.find(item => item.text.startsWith('Use the official')).evidence, undefined);
  report.scenarios.push('source-date-add-clear-no-invented-date');
  await page.close();

  for (const [locale, label] of [['en', 'Memory'], ['zh', '记忆'], ['ja', 'メモリー']]) {
    for (const width of [1280, 390]) {
      const view = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      view.on('pageerror', error => report.pageErrors.push(error.message));
      await view.addInitScript(value => {
        localStorage.setItem('agentcanvas.locale', value.locale);
        localStorage.setItem('raytonebot.theme', value.theme);
      }, { locale, theme: width === 390 ? 'warm-graphite' : 'soft-glass' });
      await view.goto(origin);
      await view.locator('.shell-footer-button').click();
      await view.locator('.settings-rail-item').filter({ hasText: new RegExp(`^${label}$`) }).click();
      await view.locator('.settings-memory-row').first().waitFor();
      await view.locator('.settings-body details').last().locator('summary').click();
      await view.setViewportSize({ width, height: 900 });
      assert.equal(await view.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const file = `batch2-memory-${locale}-${width}.png`;
      await view.screenshot({ path: join(output, file) });
      report.screenshots.push(file);
      if (width === 390) {
        const fields = view.locator('.settings-body details').last();
        await fields.scrollIntoViewIfNeeded();
        assert.ok(await fields.locator('input[type="url"]').evaluate(element => element.getBoundingClientRect().width) > 200);
        const fieldFile = `batch2-memory-${locale}-390-fields.png`;
        await view.screenshot({ path: join(output, fieldFile) });
        report.screenshots.push(fieldFile);
      }
      await view.close();
    }
  }
  report.scenarios.push('three-locales-desktop-and-390px');
  assert.deepEqual(report.pageErrors, []);
} finally {
  writeFileSync(join(output, 'batch2-browser.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
