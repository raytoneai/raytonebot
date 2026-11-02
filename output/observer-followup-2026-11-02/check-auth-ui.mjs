import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { piRuntimePlugin } from '../../src/pi/piVitePlugin.ts';
import { findHeadlessShell } from '../../src/pi/browser/browserService.ts';
import { controlPlaneCopy } from '../../src/i18n/copy/controlPlane.ts';

const output = dirname(new URL(import.meta.url).pathname);
const root = mkdtempSync(join(tmpdir(), 'rtb-observer-auth-ui-'));
process.env.RAYTONEBOT_DATA_DIR = join(root, 'data');
process.env.RAYTONEBOT_WORKSPACE_ROOT = join(root, 'workspace');
process.env.RAYTONEBOT_VAULT_DIR = join(root, 'vault');
process.env.RAYTONEBOT_SANDBOX = '0';
delete process.env.RAYTONEBOT_PUBLIC_ORIGIN;
const report = { checks: [], errors: [] };
let vite, browser, entry;
try {
  const { default: config } = await import('../../vite.config.ts');
  vite = await createServer({ ...config, configFile: false, logLevel: 'silent',
    plugins: [...config.plugins.filter(p => p.name !== 'agentcanvas-pi-runtime'), piRuntimePlugin({ openEntry(url) { entry = url; } })],
    server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  assert.ok(entry, 'host must deliver entry directly to user channel');
  const origin = new URL(entry).origin;
  browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: controlPlaneCopy.zh.settings, exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: controlPlaneCopy.zh.settings, exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, 'auth-open-settings.png') });
  report.anonymousText = await page.locator('body').innerText();
  await page.getByText(controlPlaneCopy.zh.reopen, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'auth-unauthorized.png') });
  assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/bots`)).status(), 401);
  await page.goto('about:blank');
  await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 });
  entry = undefined;
  await page.locator('.shell-footer-button').waitFor({ timeout: 30000 });
  assert.ok(new URL(page.url()).hash === '', 'entry fragment must be consumed');
  assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/auth/session`)).status(), 200);
  report.checks.push('anonymous UI remains usable; host fragment is cleared and exchanged');
  for (const locale of ['zh', 'en', 'ja']) for (const width of [1280, 390]) {
    await page.evaluate(locale => localStorage.setItem('agentcanvas.locale', locale), locale);
    await page.setViewportSize({ width, height: 900 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    if (width === 390) {
      await page.locator('.preview-rail-float[data-side="left"]').click();
    }
    // The same Settings owner is reachable through the sidebar on all layouts.
    await page.locator('.shell-footer-button:visible').last().click();
    const developer = page.getByRole('button', { name: { zh: '开发者模式', en: 'Developer', ja: '開発者モード' }[locale], exact: true });
    await developer.click();
    const copy = controlPlaneCopy[locale];
    await page.getByRole('button', { name: copy.grant, exact: true }).click();
    await page.getByRole('button', { name: copy.revoke, exact: true }).waitFor();
    const session = await (await context.request.get(`${origin}/__agentcanvas/pi/auth/session`)).json();
    assert.equal(session.developerScope, true);
    assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/learning`)).status(), 200);
    await page.screenshot({ path: join(output, `auth-${locale}-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
    await page.getByRole('button', { name: copy.revoke, exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/learning`)).status(), 403);
    assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/bots`)).status(), 200);
    report.checks.push(`${locale} ${width}: grant/read/revoke, ordinary access retained`);
  }
  const session = await (await context.request.get(`${origin}/__agentcanvas/pi/auth/session`)).json();
  const cookie = (await context.cookies()).filter(c => c.name === 'raytone_control').map(c => `${c.name}=${c.value}`).join('; ');
  const file = join(root, 'check-session.json');
  writeFileSync(file, JSON.stringify({ cookie, csrfToken: session.csrfToken }), { mode: 0o600 });
  const check = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/check-local.mjs', '--session-file', file], { cwd: process.cwd(), env: { ...process.env, RAYTONEBOT_URL: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', status => resolve({ status, stdout, stderr }));
  });
  report.checkLocal = check;
  assert.equal(check.status, 0, check.stderr);
  await context.close();
} catch (error) {
  report.errors.push((error instanceof Error ? error.message : String(error)).replace(/#control-plane=[^\s'"<>]+/g, '#control-plane=<redacted>'));
} finally {
  await browser?.close();
  await vite?.close();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'auth-ui-results.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
if (report.errors.length) process.exitCode = 1;
