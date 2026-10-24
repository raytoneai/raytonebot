import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { project } from '../../src/exported-project.ts';
// Run only against the isolated review host; never point this at a user's saved settings.
const url = process.env.REVIEW_BASE_URL;
if (!url) throw new Error('REVIEW_BASE_URL must name an isolated test host');
const providers = structuredClone(project.providers);
providers.defaultProviderId = 'deepseek';
const target = providers.connections.find(p => p.id === 'openai');
target.enabled = true; target.models = ['gpt-4o', 'review-selected-model']; target.defaultModel = 'gpt-4o';
const endpoint = url + '/__agentcanvas/pi/providers';
const before = await (await fetch(endpoint)).json();
assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers, revision: before.revision }) })).status, 200);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  const responses = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url() === endpoint && response.request().method() === 'POST') responses.push(response.status()); });
  // This exported configuration hides the optional menu. Exercise its existing supported surface.
  await page.route('**/src/exported-project.ts*', async route => {
    const response = await route.fetch();
    const text = await response.text();
    const body = text.replace(/("?modelSwitcher"?:\s*)false/g, '$1true');
    assert.notEqual(body, text);
    await route.fulfill({ response, body });
  });
  // No model invocation or SDK session is needed to check the selected pair.
  await page.route('**/__agentcanvas/pi/config', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { available: true, provider: body.provider, model: body.model, models: [], tools: [] } });
  });
  await page.goto(url);
  await page.locator('.provider-model-picker button').click();
  await page.getByRole('menuitemradio', { name: 'review-selected-model', exact: true }).click();
  await page.waitForResponse(response => response.url().endsWith('/__agentcanvas/pi/config'));
  const saved = await (await fetch(endpoint)).json();
  const result = { responses, provider: saved.providers.defaultProviderId, model: saved.providers.connections.find(p => p.id === 'openai').defaultModel, oldModel: saved.providers.connections.find(p => p.id === 'deepseek').defaultModel, errors };
  console.log(JSON.stringify(result));
  assert.deepEqual(responses, [200], 'one selection must make exactly one successful save');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'review-selected-model');
  assert.equal(result.oldModel, providers.connections.find(p => p.id === 'deepseek').defaultModel);
  assert.deepEqual(errors, []);
  await page.reload();
  await page.locator('.provider-model-summary em', { hasText: 'review-selected-model' }).waitFor();
  await page.screenshot({ path: 'output/review-fixes-2026-10-24/provider-selection.png' });
  // A same-service selection uses the same single-transaction path.
  responses.length = 0;
  await page.locator('.provider-model-picker button').click();
  const switched = page.waitForResponse(response => response.url().endsWith('/__agentcanvas/pi/config'));
  await page.getByRole('menuitemradio', { name: 'gpt-4o', exact: true }).click();
  await switched;
  assert.deepEqual(responses, [200]);
  await page.locator('.provider-model-summary em', { hasText: /^gpt-4o$/ }).waitFor();
  // Rejected saves leave the applied model alone and expose a retryable error in the owner.
  await page.route('**/__agentcanvas/pi/providers', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 409, json: { error: 'Review save rejected' } });
    else await route.continue();
  });
  await page.locator('.provider-model-picker button').click();
  await page.getByRole('menuitemradio', { name: 'review-selected-model', exact: true }).click();
  await page.getByText('Review save rejected', { exact: true }).waitFor();
  assert.equal(await page.locator('.provider-model-summary em').innerText(), 'gpt-4o');
  assert.deepEqual(errors, []);
  console.log('PASS: cross-provider choice, same-provider choice, refresh, rejected-save feedback');
} finally { await browser.close(); }
