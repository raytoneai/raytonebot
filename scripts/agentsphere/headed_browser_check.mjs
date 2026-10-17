/** Destructive only to the EMPTY test sandbox profile. Run before any real account login. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createBrowserService } from '../../src/pi/browser/browserService.ts';

assert.equal(process.env.RAYTONEBOT_BROWSER_HEADED, '1', 'source the headed test deployment env');
assert.equal(process.env.RAYTONEBOT_BROWSER_TRIAL_EMPTY, '1', 'never run against an account-bearing profile');
const dataDir = mkdtempSync(join(tmpdir(), 'rtb-headed-'));
const browser = createBrowserService({ dataDir });
const tools = browser.toolsFor({ conversationId: 'headed-check', agent: 'assistant',
  async saveDownload() { throw new Error('not used'); }, async ask() { return null; } });
const report = { checks: [], sites: {} };
const pass = (name) => report.checks.push(name);
const open = async (url) => {
  const result = await tools.run('browser_open', { url });
  assert.equal(result.isError, false, result.text);
  return result.text;
};
let stopWatching;
try {
  let frames = 0;
  stopWatching = browser.watch((event) => { if (event.type === 'frame') frames += 1; });
  await open('https://example.com');
  const remote = await chromium.connectOverCDP('http://127.0.0.1:5192');
  const context = remote.contexts()[0];
  const page = context.pages()[0];
  report.fingerprint = await page.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: navigator.webdriver }));
  assert.doesNotMatch(report.fingerprint.userAgent, /HeadlessChrome/);
  assert.equal(report.fingerprint.webdriver, false);
  pass('headed browser identity without UA overrides');
  const sandboxPage = await context.newPage();
  await sandboxPage.goto('chrome://sandbox');
  const sandboxText = await sandboxPage.locator('body').innerText();
  report.sandbox = sandboxText;
  assert.match(sandboxText, /Seccomp-BPF sandbox\s+Yes/);
  await sandboxPage.close();
  pass('Chromium seccomp sandbox enabled');
  const processes = execFileSync('ps', ['-u', 'raytone-browser', '-o', 'args='], { encoding: 'utf8' });
  assert.match(processes, /Xvfb/);
  assert.doesNotMatch(processes, /--no-sandbox|--headless|--user-agent/);
  pass('browser and Xvfb run under browser UID, no sandbox-disabling flags');
  await context.addCookies([{ name: 'rtb_trial', value: 'test-only', url: 'https://example.com', expires: Date.now() / 1000 + 3600 }]);
  await page.evaluate(() => localStorage.setItem('rtb_trial', 'test-only'));
  assert.ok((await context.cookies('https://example.com')).some((cookie) => cookie.name === 'rtb_trial'), 'test cookie was not accepted');
  await browser.takeover();
  assert.match((await tools.run('browser_snapshot', {})).text, /user is controlling/);
  await browser.input({ kind: 'key', type: 'down', key: 'Tab' });
  await browser.input({ kind: 'key', type: 'up', key: 'Tab' });
  browser.release();
  await browser.stop();
  await open('https://example.com');
  const again = await chromium.connectOverCDP('http://127.0.0.1:5192');
  assert.ok((await again.contexts()[0].cookies('https://example.com')).some((cookie) => cookie.name === 'rtb_trial'));
  assert.equal(await again.contexts()[0].pages()[0].evaluate(() => localStorage.getItem('rtb_trial')), 'test-only');
  pass('takeover, hand-back and profile persistence across full browser restart');
  await browser.clearLogins();
  await open('https://example.com');
  const fresh = await chromium.connectOverCDP('http://127.0.0.1:5192');
  assert.ok(!(await fresh.contexts()[0].cookies('https://example.com')).some((cookie) => cookie.name === 'rtb_trial'));
  assert.equal(await fresh.contexts()[0].pages()[0].evaluate(() => localStorage.getItem('rtb_trial')), null);
  pass('clear login state removes cookies and local storage on Linux');
  const blocked = await tools.run('browser_open', { url: 'http://127.0.0.1:5188/' });
  assert.match(blocked.text, /refused|public|403/i);
  pass('browser proxy still refuses private destinations');
  for (const [site, url] of Object.entries({ github: 'https://github.com/login', reddit: 'https://www.reddit.com/login/', x: 'https://x.com/i/flow/login', google: 'https://accounts.google.com/' })) {
    const result = await tools.run('browser_open', { url });
    report.sites[site] = { error: result.isError, url: browser.view().url, title: browser.view().title,
      loginNotTested: true, networkNotice: /page answered HTTP|refused|blocked|denied|not supported|not secure/i.test(result.text) };
  }
  assert.ok(frames > 0, 'live screencast produced no frames');
  report.frames = frames;
  pass('live frames produced through the existing service');
} catch (error) {
  console.error(JSON.stringify(report));
  throw error;
} finally {
  stopWatching?.();
  await browser.stop();
  await browser.clearLogins();
  rmSync(dataDir, { recursive: true, force: true });
}
const remaining = execFileSync('ps', ['-eo', 'user:32=,args='], { encoding: 'utf8' }).split('\n')
  .filter((line) => /^raytone-browser\s/.test(line) && /Xvfb|chrome-linux64\/chrome/.test(line));
assert.deepEqual(remaining, [], 'stop left browser/display processes behind');
pass('stop cleans up both Chrome and Xvfb');
console.log(JSON.stringify(report, null, 2));
