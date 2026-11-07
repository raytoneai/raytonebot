import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { findHeadlessShell } from '../pi/browser/browserService.ts';
import { PROVIDER_MASCOTS, PROVIDER_MASCOT_NAMES } from './botAppearance.ts';

test('provider avatars use the existing editor, interruptible live states and reduced motion', { skip: !findHeadlessShell() && 'Chromium not installed', timeout: 60_000 }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'rtb-avatar-ui-'));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    plugins: [{ name: 'avatar-test', configureServer(vite) {
      vite.middlewares.use('/avatar-test', async (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(await vite.transformIndexHtml('/avatar-test', `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
          import {createElement as h,useState} from 'react'; import {createRoot} from 'react-dom/client';
          import {BotEditor} from '/src/components/shell/BotEditor.tsx';
          import {LocaleProvider} from '/src/i18n/LocaleContext.tsx';
          import {DEFAULT_BOTS} from '/src/runtime/botAppearance.ts';
          import '/src/styles/app.css'; import '/src/styles/agentmatrix.css';
          function Probe(){
            const [draft,onChange]=useState({id:'assistant',presetId:'assistant',name:'Preview',appearance:DEFAULT_BOTS.woman});
            return h(BotEditor,{draft,onChange,creating:false,onSave(){},onClose(){}});
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider,{initialLocale:new URLSearchParams(location.search).get('locale')||'en'},h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__agentcanvas/pi/bots', route => route.fulfill({ json: { revision: 0, profiles: [] } }));
    const base = server.resolvedUrls!.local[0];
    await page.goto(`${base}avatar-test`);
    await page.getByText('Avatar and appearance', { exact: true }).click();
    const preview = page.locator('.bot-creator-preview .raytone-avatar');
    const motion = page.getByRole('combobox', { name: 'Preview motion' });
    const theme = page.getByRole('combobox', { name: 'Avatar theme' });
    assert.equal(await theme.inputValue(), 'custom');
    assert.equal(await theme.locator('option').count(), 2, 'all six model characters belong to one theme');
    assert.equal(await page.locator('.bot-character-options').count(), 0);
    await theme.selectOption('model-companions');
    assert.equal(await preview.locator('svg').getAttribute('data-mascot'), 'chatgpt');
    assert.equal(await page.locator('.bot-character-options button').count(), 6);
    for (const mascot of PROVIDER_MASCOTS) {
      await page.getByRole('button', { name: PROVIDER_MASCOT_NAMES[mascot], exact: true }).click();
      assert.equal(await preview.locator('svg').getAttribute('data-mascot'), mascot);
      assert.equal(await page.locator('.bot-part-options').count(), 0);
      for (const [state, selector, animation] of [
        ['thinking', '.thinking-gaze', 'raytone-look-up'],
        ['writing', '.action-group', 'raytone-talk'],
        ['working', '.thinking-gaze', 'raytone-scan'],
      ]) {
        await motion.selectOption(state);
        await page.waitForFunction(state => document.querySelector('.bot-creator-preview .raytone-avatar')?.getAttribute('data-state') === state, state);
        assert.equal(await preview.locator(selector).evaluate(el => getComputedStyle(el).animationName), animation);
      }
    }
    await motion.selectOption('editing');
    await motion.selectOption('thinking');
    await motion.selectOption('writing');
    await page.waitForFunction(() => document.querySelector('.bot-creator-preview .raytone-avatar')?.getAttribute('data-state') === 'writing');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.bot-creator-preview .raytone-avatar')?.getAttribute('data-reduced') === 'true');
    assert.equal(await preview.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.equal(await preview.locator('.expression').first().evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 0.9, 0, 0)', 'state expression remains visible without movement');
    await theme.selectOption('custom');
    assert.equal(await preview.locator('svg').getAttribute('data-mascot'), null);
    assert.equal(await page.getByRole('button', { name: 'Long', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.bot-character-options').count(), 0);
    await theme.selectOption('model-companions');
    assert.equal(await preview.locator('svg').getAttribute('data-mascot'), 'qwen', 'switching themes within an edit keeps the last model character');
    await page.getByRole('button', { name: 'Default avatar', exact: true }).click();
    assert.equal(await theme.inputValue(), 'custom');
    assert.equal(await preview.locator('svg').getAttribute('data-mascot'), null);
    for (const [locale, themeLabel, label] of [['zh', '头像主题', '预览动作'], ['ja', 'アバターのテーマ', '動きをプレビュー']]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}avatar-test?locale=${locale}`);
      await page.getByRole('combobox', { name: label }).waitFor();
      await page.locator('details').last().locator('summary').click();
      await page.getByRole('combobox', { name: themeLabel }).selectOption('model-companions');
      assert.equal(await page.locator('.bot-character-options button').count(), 6);
      assert.ok((await page.locator('.bot-character-options button').first().boundingBox())!.width >= 44);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
      assert.equal(await preview.locator('svg').getAttribute('data-mascot'), 'deepseek');
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
