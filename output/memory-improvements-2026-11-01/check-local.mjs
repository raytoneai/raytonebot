import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'raytone-memory-check-'));
process.env.RAYTONEBOT_DATA_DIR = join(root, 'data');
process.env.RAYTONEBOT_WORKSPACE_ROOT = join(root, 'workspace');
process.env.RAYTONEBOT_VAULT_DIR = join(root, 'vault');
process.env.RAYTONEBOT_SANDBOX = '0';
const { createServer } = await import('vite');
const server = await createServer({ server: { port: 0, strictPort: true, host: '127.0.0.1', hmr: false, ws: false } });
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No verification server port');
  // Async child execution keeps the in-process HTTP server available to the check.
  const { spawn } = await import('node:child_process');
  const status = await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'check:local'], { stdio: 'inherit', env: { ...process.env, RAYTONEBOT_URL: `http://127.0.0.1:${address.port}` } });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (status !== 0) throw new Error(`check:local exited ${status}`);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
