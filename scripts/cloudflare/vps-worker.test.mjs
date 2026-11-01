import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './vps-worker.mjs';

const PUBLIC_ORIGIN = 'https://bot.example.com';

test('requires Access identity and forwards only to the private origin', async () => {
  const request = new Request(`${PUBLIC_ORIGIN}/test?q=1`, {
    method: 'POST', body: 'hello', headers: { origin: PUBLIC_ORIGIN, 'x-forwarded-host': 'attacker.example' },
  });
  let forwarded;
  const env = { PUBLIC_ORIGIN, ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com', ORIGIN_PASSWORD: 'secret',
    RAYTONEBOT_ORIGIN: { fetch: async (req) => { forwarded = req; return new Response('ok'); } } };
  assert.equal((await worker.fetch(request, env, {})).status, 403);
  const wrong = { access: { aud: 'aud', getIdentity: async () => ({ email: 'wrong@example.com' }) } };
  assert.equal((await worker.fetch(request, env, wrong)).status, 403);
  const correct = { access: { aud: 'aud', getIdentity: async () => ({ email: 'owner@example.com' }) } };
  assert.equal((await worker.fetch(request, env, correct)).status, 200);
  assert.equal(forwarded.url, 'http://127.0.0.1:5188/test?q=1');
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'bot.example.com');
  assert.equal(forwarded.headers.get('authorization'), `Basic ${btoa('raytonebot:secret')}`);
  assert.equal(await forwarded.text(), 'hello');
});

test('permits an authenticated top-level entry navigation without weakening API checks', async () => {
  let forwarded;
  const env = { PUBLIC_ORIGIN, ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com', ORIGIN_PASSWORD: 'secret',
    RAYTONEBOT_ORIGIN: { fetch: async (req) => { forwarded = req; return new Response('ok'); } } };
  const ctx = { access: { aud: 'aud', getIdentity: async () => ({ email: 'owner@example.com' }) } };
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  await worker.fetch(new Request(`${PUBLIC_ORIGIN}/`, { headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'none');
  await worker.fetch(new Request(`${PUBLIC_ORIGIN}/__agentcanvas/pi/state`, { headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'cross-site');
  await worker.fetch(new Request(`${PUBLIC_ORIGIN}/`, { method: 'POST', headers }), env, ctx);
  assert.equal(forwarded.headers.get('sec-fetch-site'), 'cross-site');
});

test('rejects invalid origin or missing Access configuration before calling the origin', async () => {
  let calls = 0;
  const env = { PUBLIC_ORIGIN, ACCESS_AUD: 'aud', ACCESS_EMAIL: 'owner@example.com', ORIGIN_PASSWORD: 'secret',
    RAYTONEBOT_ORIGIN: { fetch: async () => { calls++; return new Response('ok'); } } };
  const ctx = { access: { aud: 'aud', getIdentity: async () => ({ email: 'owner@example.com' }) } };
  const request = new Request(`${PUBLIC_ORIGIN}/`);
  for (const origin of [undefined, '', 'not-a-url', 'http://bot.example.com', `${PUBLIC_ORIGIN}/path`,
    `${PUBLIC_ORIGIN}/path/..`, `${PUBLIC_ORIGIN}/?q=1`, `${PUBLIC_ORIGIN}/#fragment`, 'https://user@bot.example.com']) {
    assert.equal((await worker.fetch(request, { ...env, PUBLIC_ORIGIN: origin }, ctx)).status, 403, String(origin));
  }
  for (const key of ['ACCESS_AUD', 'ACCESS_EMAIL']) {
    for (const value of [undefined, '', '   ']) {
      assert.equal((await worker.fetch(request, { ...env, [key]: value }, ctx)).status, 403, key);
    }
  }
  const emptyIdentity = { access: { aud: undefined, getIdentity: async () => ({}) } };
  assert.equal((await worker.fetch(request, { ...env, ACCESS_AUD: undefined, ACCESS_EMAIL: undefined }, emptyIdentity)).status, 403);
  assert.equal((await worker.fetch(new Request('https://other.example.com/'), env, ctx)).status, 403);
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request, { ...env, PUBLIC_ORIGIN: `${PUBLIC_ORIGIN}/` }, ctx)).status, 200);
});
