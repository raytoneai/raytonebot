import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const origin = process.env.RAYTONEBOT_URL ?? 'http://127.0.0.1:5188';
const sessionIndex = process.argv.indexOf('--session-file');
let session;
if (sessionIndex !== -1) {
  const path = process.argv[sessionIndex + 1];
  assert.ok(path, '--session-file requires a private operator/test session file');
  assert.equal(statSync(path).mode & 0o077, 0, 'session file must be private (0600)');
  session = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(typeof session.cookie, 'string');
  assert.equal(typeof session.csrfToken, 'string');
}
const request = (path, options = {}) => fetch(new URL(path, origin), {
  ...options,
  headers: { ...(session ? { cookie: session.cookie, 'x-raytonebot-csrf': session.csrfToken } : {}), ...options.headers },
  signal: AbortSignal.timeout(15000),
});
const page = await request('/');
assert.equal(page.status, 200);
assert.match(await page.text(), /RaytoneBot/);
const stateResponse = await request('/__agentcanvas/pi/state');
assert.equal(stateResponse.status, 200, 'A user control session is required. Use --session-file with an isolated test or operator session; anonymous management access is disabled.');
const state = await stateResponse.json();
assert.equal(state.available, true, state.error);
for (const tool of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'update_plan', 'ask_user', 'connect_channel', 'create_routine', 'publish_artifact']) {
  assert.ok(state.tools.includes(tool), `Missing tool: ${tool}`);
}
const empty = await request('/__agentcanvas/pi/prompt', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
assert.equal(empty.status, 400);
const foreign = await request('/__agentcanvas/pi/prompt', {
  method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{}',
});
assert.equal(foreign.status, 403);
console.log('PASS: UI, Pi SDK, 12 tools, empty-prompt validation, cross-origin rejection. No model request made.');
