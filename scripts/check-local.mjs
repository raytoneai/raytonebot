import assert from 'node:assert/strict';

const origin = process.env.RAYTONEBOT_URL ?? 'http://127.0.0.1:5188';
const request = (path, options = {}) => fetch(new URL(path, origin), {
  ...options,
  signal: AbortSignal.timeout(15000),
});
const page = await request('/');
assert.equal(page.status, 200);
assert.match(await page.text(), /RaytoneBot/);
const stateResponse = await request('/__agentcanvas/pi/state');
assert.equal(stateResponse.status, 200);
const state = await stateResponse.json();
assert.equal(state.available, true, state.error);
for (const tool of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'update_plan', 'ask_user']) {
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
console.log('PASS: UI, Pi SDK, 9 tools, empty-prompt validation, cross-origin rejection. No model request made.');
