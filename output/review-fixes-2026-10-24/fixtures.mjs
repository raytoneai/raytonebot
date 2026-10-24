import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage(); const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5188/?devtools=1');
  const picker = page.getByRole('button', { name: '选择事件流', exact: true });
  await picker.click();
  const labels = await page.getByRole('menuitemradio').allTextContents();
  await page.keyboard.press('Escape');
  for (const label of labels) {
    await picker.click(); await page.getByRole('menuitemradio', { name: label.trim(), exact: true }).click();
    await page.locator('.preview-frame').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, label);
    results.push({ label: label.trim(), overflow });
  }
  assert.deepEqual(errors, []);
  await writeFile('output/review-fixes-2026-10-24/fixtures.json', JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ scenarios: results.length, errors }));
} finally { await browser.close(); }
