// Real isolated Vite/HTTP host; no model request, user data, or saved credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { piRuntimePlugin } from '../../src/pi/piVitePlugin.ts';

const root = mkdtempSync(join(tmpdir(), 'rtb-reliability-check-'));
process.env.RAYTONEBOT_DATA_DIR = join(root, 'data');
process.env.RAYTONEBOT_WORKSPACE_ROOT = join(root, 'workspace');
process.env.RAYTONEBOT_VAULT_DIR = join(root, 'vault');
process.env.RAYTONEBOT_SANDBOX = '0';
delete process.env.RAYTONEBOT_PUBLIC_ORIGIN;
let vite, entry;
try {
  const { default: config } = await import('../../vite.config.ts');
  vite = await createServer({ ...config, configFile: false, logLevel: 'silent',
    plugins: [...config.plugins.filter(p => p.name !== 'agentcanvas-pi-runtime'), piRuntimePlugin({ openEntry(url) { entry = url; } })],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  assert.ok(entry);
  const origin = new URL(entry).origin;
  const response = await fetch(`${origin}/__agentcanvas/pi/auth/exchange`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ secret: new URL(entry).hash.slice('#control-plane='.length) }),
  });
  entry = undefined;
  assert.equal(response.status, 200);
  const { csrfToken } = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const sessionFile = join(root, 'session.json');
  writeFileSync(sessionFile, JSON.stringify({ cookie, csrfToken }), { mode: 0o600 });
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/check-local.mjs', '--session-file', sessionFile], {
      env: { ...process.env, RAYTONEBOT_URL: origin }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject); child.on('exit', resolve);
  });
  assert.equal(status, 0);
} finally {
  await vite?.close();
  rmSync(root, { recursive: true, force: true });
}
