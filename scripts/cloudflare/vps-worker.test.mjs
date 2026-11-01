import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './vps-worker.mjs';

test('requires Access identity and forwards only to the private origin', async () => {
  const request = new Request('https://raytonebot.flamington2k.workers.dev/test?q=1', {
    method: 'POST', body: 'hello', headers: { origin: 'https://raytonebot.flamington2k.workers.dev', 'x-forwarded-host': 'attacker.example' },
  });
  let forwarded;
  const env = { ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com', ORIGIN_PASSWORD: 'secret',
    RAYTONEBOT_ORIGIN: { fetch: async (req) => { forwarded = req; return new Response('ok'); } } };
  assert.equal((await worker.fetch(request, env, {})).status, 403);
  const wrong = { access: { aud: 'aud', getIdentity: async () => ({ email: 'wrong@example.com' }) } };
  assert.equal((await worker.fetch(request, env, wrong)).status, 403);
  const correct = { access: { aud: 'aud', getIdentity: async () => ({ email: 'owner@example.com' }) } };
  assert.equal((await worker.fetch(request, env, correct)).status, 200);
  assert.equal(forwarded.url, 'http://127.0.0.1:5188/test?q=1');
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'raytonebot.flamington2k.workers.dev');
  assert.equal(forwarded.headers.get('authorization'), `Basic ${btoa('raytonebot:secret')}`);
  assert.equal(await forwarded.text(), 'hello');
});

test('permits an authenticated top-level entry navigation without weakening API checks', async () => {
  let forwarded;
  const env = { ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com', ORIGIN_PASSWORD: 'secret',
    RAYTONEBOT_ORIGIN: { fetch: async (req) => { forwarded = req; return new Response('ok'); } } };
  const ctx = { access: { aud: 'aud', getIdentity: async () => ({ email: 'owner@example.com' }) } };
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  await worker.fetch(new Request('https://raytonebot.flamington2k.workers.dev/', { headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'none');
  await worker.fetch(new Request('https://raytonebot.flamington2k.workers.dev/__agentcanvas/pi/state', { headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'cross-site');
  await worker.fetch(new Request('https://raytonebot.flamington2k.workers.dev/', { method: 'POST', headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'cross-site');
});
