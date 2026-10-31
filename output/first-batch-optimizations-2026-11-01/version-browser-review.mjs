import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findHeadlessShell } from '../../src/pi/browser/browserService.ts';
const output = 'output/first-batch-optimizations-2026-11-01';
const origin = 'http://127.0.0.1:5197';
const { testRoot } = JSON.parse(readFileSync(join(output, 'model-smoke-before-refinement.json'), 'utf8'));
const source = join(testRoot, 'skill/workspace/report.md');
const original = readFileSync(source);
const expected = [1, 2].map(n => readFileSync(join(output, `model-reports/skill-before-refinement-${n}.md`), 'utf8'));
const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
const findings = { scenarios: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => findings.errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: /^请研究 https:/ }).click();
  await page.locator('button.artifact-launch-card').filter({ hasText: 'report.md' }).nth(1).click();
  const select = page.locator('[data-version-selector] select');
  await select.waitFor();
  const options = await select.locator('option').evaluateAll(els => els.map(el => ({ value: el.value, text: el.textContent })));
  const versions = options.filter(o => o.value !== 'current');
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].text, versions[1].text);
  const panel = page.locator('.opened-output').filter({ has: select }).first();
  const download = panel.locator('a[download]').first();
  for (let n = 0; n < 2; n++) {
    await select.selectOption(versions[n].value);
    await page.waitForFunction(versionId => document.querySelector('.opened-output a[download]')?.getAttribute('href')?.includes(versionId), versions[n].value);
    const href = await download.getAttribute('href');
    const response = await page.request.get(new URL(href, origin).href);
    assert.equal(response.status(), 200); assert.equal(await response.text(), expected[n]);
    assert.equal(await panel.locator('.document-actions').count(), 0);
    findings.scenarios.push(`historical-${n + 1}-exact-bytes`);
  }
  await select.selectOption('current');
  await page.waitForFunction(() => document.querySelector('.opened-output a[download]')?.getAttribute('href')?.includes('scope='));
  await panel.locator('.markdown-preview').waitFor();
  assert.match(await panel.innerText(), /USER_KEEP/);
  assert.ok(await panel.getByRole('button', { name: /编辑/ }).count());
  findings.scenarios.push('current-body-and-editor');
  unlinkSync(source);
  await select.selectOption(versions[0].value);
  await page.waitForFunction(versionId => document.querySelector('.opened-output a[download]')?.getAttribute('href')?.includes(versionId), versions[0].value);
  const afterDelete = await page.request.get(new URL(await download.getAttribute('href'), origin).href);
  assert.equal(await afterDelete.text(), expected[0]);
  findings.scenarios.push('source-deleted-history-still-readable');
  await page.screenshot({ path: join(output, 'version-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.locator('button.artifact-launch-card').filter({ hasText: 'report.md' }).nth(1).click();
  await select.waitFor({ state: 'visible' });
  await select.selectOption(versions[0].value);
  await page.locator('.opened-output .markdown-preview').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false);
  const geometry = await select.evaluate(el => {
    const selector = el.closest('[data-version-selector]').getBoundingClientRect();
    const control = el.getBoundingClientRect();
    const modal = el.closest('.artifact-frame[data-expanded="true"][data-output-modal="true"]').getBoundingClientRect();
    return { selectorHeight: selector.height, controlHeight: control.height, controlTop: control.top,
      controlBottom: control.bottom, modalTop: modal.top, modalBottom: modal.bottom };
  });
  assert.ok(geometry.selectorHeight >= geometry.controlHeight);
  assert.ok(geometry.controlTop >= geometry.modalTop && geometry.controlBottom <= geometry.modalBottom);
  findings.mobileGeometry = geometry;
  const readerGeometry = await page.locator('.opened-output .markdown-preview').evaluate(el => {
    const reader = el.getBoundingClientRect();
    return { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
      widestParagraph: Math.max(0, ...Array.from(el.querySelectorAll('p, h1, h2, h3, h4, h5, h6')).map(p => p.getBoundingClientRect().width)),
      width: reader.width };
  });
  assert.ok(readerGeometry.widestParagraph <= readerGeometry.clientWidth + 1);
  findings.mobileReaderGeometry = readerGeometry;
  await page.screenshot({ path: join(output, 'version-mobile.png') });
  findings.scenarios.push('390px-version-preview-no-overflow');
  assert.deepEqual(findings.errors, []);
} finally {
  writeFileSync(source, original);
  writeFileSync(join(output, 'version-browser-review.json'), JSON.stringify(findings, null, 2));
  await browser.close();
}
console.log(JSON.stringify(findings));
