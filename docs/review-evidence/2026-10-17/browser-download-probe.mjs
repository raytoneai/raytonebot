import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBrowserService, findHeadlessShell } from '../../../src/pi/browser/browserService.ts';

const dir = mkdtempSync('/tmp/raytone-review-browser-');
let downloadResponse;
let signalStarted;
const started = new Promise(resolve => { signalStarted = resolve; });
const server = createServer((req, res) => {
  if (req.url === '/file') {
    downloadResponse = res;
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="probe.txt"', 'content-length': '10' });
    res.write('first');
    signalStarted();
  } else { res.end('<a href="/file">Download</a>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = createBrowserService({ dataDir: dir, executable: findHeadlessShell(), allowAddress: () => true, allowPort: () => true });
const saved = [];
const context = (conversationId, agent) => ({ conversationId, agent, ask: async () => null,
  saveDownload: async (name, bytes) => { saved.push({ conversationId, agent, name, bytes: bytes.toString() }); return `/temporary/${agent}/${name}`; } });
const a = browser.toolsFor(context('conversation-A', 'assistant'));
const b = browser.toolsFor(context('conversation-B', 'builder'));
const watchdog = setTimeout(() => { console.error('probe timeout'); process.exit(1); }, 20000);
try {
  assert.ok(a && b, 'Chromium required');
  const url = `http://127.0.0.1:${server.address().port}`;
  await a.run('browser_open', { url });
  const downloading = a.run('browser_open', { url: url + '/file' });
  await started;
  await b.run('browser_accounts', {});
  downloadResponse.end('later');
  await downloading;
  for (let i = 0; i < 100 && !saved.length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].conversationId, 'conversation-B');
  console.log('CONFIRMED: A starts a delayed download; B only calls browser_accounts; A download is saved with B context:', JSON.stringify(saved));
} finally {
  clearTimeout(watchdog);
  await browser.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
