import assert from 'node:assert/strict';
import { appendFileSync, statSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { preview } from 'vite';
import {
  HANDOFF_PATH, SESSION_COOKIE, SESSION_TTL_MS, assertHandoffSecret, handoffRedeemer, issueHandoff, issueSession,
  readCookie, sessionValid,
} from './handoff.mjs';

const port = 5188;
const localOrigin = `http://127.0.0.1:${port}`;
const digest = (value) => createHash('sha256').update(value).digest();

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:16px/1.6 sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem">${body}</body></html>`;

// Protect Pi and static assets before their route handlers.
// Only this authenticated boundary may normalize cloud requests for the local Pi host.
// With a handoff secret (ADR-041) the welcome page's one-time link becomes a session cookie;
// Basic Auth stays for operators and the control service's own health checks.
// `trustProxy` is for a reverse proxy that terminates TLS and forwards the public Host in
// x-forwarded-host (the AgentMatrix PreviewProxy). It is opt-in and only safe when the proxy
// overwrites that header: a directly reachable server would let a caller forge it.
function accessGate(publicOrigin, password, handoff, { trustProxy = false } = {}) {
  const origin = new URL(publicOrigin);
  assert.equal(origin.protocol, 'https:', 'RAYTONEBOT_PUBLIC_ORIGIN must use HTTPS');
  assert.equal(origin.href, `${origin.origin}/`, 'Use a bare public origin');
  assert.ok(password?.length >= 24, 'RAYTONEBOT_PASSWORD must contain at least 24 characters');
  const expected = digest(`Basic ${Buffer.from(`raytonebot:${password}`).toString('base64')}`);
  const secret = handoff?.secret;
  if (secret !== undefined) assertHandoffSecret(secret);
  const control = handoff?.controlOrigin ? new URL(handoff.controlOrigin).origin : undefined;
  const redeem = secret ? handoffRedeemer(secret, origin.origin) : undefined;
  const welcomeLink = control ? `<p><a href="${control}/welcome">回到欢迎页重新进入</a></p>` : '';

  const headerLog = process.env.RAYTONEBOT_HEADER_LOG;

  return (req, res, next) => {
    if (headerLog) {
      try {
        // Bounded, opt-in diagnostic for adapting to a new reverse proxy.
        if ((statSync(headerLog, { throwIfNoEntry: false })?.size ?? 0) < 256 * 1024) {
          appendFileSync(headerLog, `${JSON.stringify({ url: req.url, headers: req.headers })}\n`);
        }
      } catch { /* diagnostics must never break serving */ }
    }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    const reject = (status, message) => { res.statusCode = status; res.end(message); };
    const html = (status, markup) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.end(markup);
    };
    // A reverse proxy may rewrite Host to the upstream address. When it does, the only
    // trustworthy signal left is that the request arrived through the proxy port; a
    // direct request cannot present a loopback Host plus that marker.
    const forwardedHost = trustProxy ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
    const forwardedPort = trustProxy ? String(req.headers['x-forwarded-port'] ?? '').split(',')[0].trim() : '';
    const proxiedLoopback = req.headers.host === new URL(localOrigin).host && (forwardedPort === '443' || forwardedPort === '80');
    if (req.headers.host !== origin.host && forwardedHost !== origin.host && !proxiedLoopback) {
      return reject(403, 'Unexpected host');
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === HANDOFF_PATH) {
      if (!redeem || req.method !== 'GET') return reject(404, 'Not found');
      // Arrives as a cross-site navigation from the welcome page: the one-time token is the credential.
      const token = new URL(req.url, origin).searchParams.get('t');
      if (!redeem(token)) return html(401, page('链接已失效', `<p>这个进入链接已失效或已使用。</p>${welcomeLink}`));
      res.setHeader('set-cookie', `${SESSION_COOKIE}=${issueSession(secret)}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      // A same-origin follow-up navigation, so the app's own requests pass the cross-site check below.
      return html(200, page('RaytoneBot', '<meta http-equiv="refresh" content="0;url=/"><p>正在进入…</p>'));
    }
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const session = secret ? readCookie(req.headers.cookie, SESSION_COOKIE) : undefined;
    if (!timingSafeEqual(digest(authorization), expected) && !(session && sessionValid(secret, session))) {
      if (!secret) {
        res.setHeader('www-authenticate', 'Basic realm="RaytoneBot", charset="UTF-8"');
        return reject(401, 'Authentication required');
      }
      return html(401, page('需要重新进入', `<p>登录已过期，请从欢迎页进入。</p>${welcomeLink}`));
    }
    if ((req.headers.origin !== undefined && req.headers.origin !== origin.origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return reject(403, 'Cross-origin requests are not allowed');
    }
    delete req.headers.authorization;
    req.headers.host = new URL(localOrigin).host;
    if (req.headers.origin !== undefined) req.headers.origin = localOrigin;
    next();
  };
}

if (process.argv.includes('--check')) {
  const password = 'test-password-with-at-least-24-characters';
  const origin = 'https://preview.example.com';
  const auth = `Basic ${Buffer.from(`raytonebot:${password}`).toString('base64')}`;
  const gate = accessGate(origin, password);
  const check = (headers) => {
    const req = { headers: { host: 'preview.example.com', ...headers } };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() {} };
    let accepted = false;
    gate(req, res, () => { accepted = true; });
    return { req, res, accepted };
  };
  assert.equal(check({}).res.statusCode, 401);
  assert.equal(check({ authorization: 'Basic wrong' }).res.statusCode, 401);
  // A proxy-forwarded host is trusted only when explicitly enabled.
  assert.equal(check({ authorization: auth, host: '127.0.0.1:5188', 'x-forwarded-host': new URL(origin).host }).res.statusCode, 403);
  const proxied = accessGate(origin, password, undefined, { trustProxy: true });
  const throughProxy = (headers) => {
    const req = { method: 'GET', url: '/', headers: { host: '127.0.0.1:5188', ...headers } };
    const res = { statusCode: 200, setHeader() {}, end() {} };
    let accepted = false;
    proxied(req, res, () => { accepted = true; });
    return { req, res, accepted };
  };
  assert.equal(throughProxy({ authorization: auth, 'x-forwarded-host': new URL(origin).host }).accepted, true);
  assert.equal(throughProxy({ authorization: auth, 'x-forwarded-host': 'attacker.example.com' }).res.statusCode, 403);
  assert.equal(throughProxy({ authorization: auth }).res.statusCode, 403);
  // PreviewProxy rewrites Host to the upstream and marks the original port instead.
  assert.equal(throughProxy({ authorization: auth, 'x-forwarded-port': '443' }).accepted, true);
  assert.equal(throughProxy({ authorization: auth, 'x-forwarded-port': '8080' }).res.statusCode, 403);
  assert.equal(check({ authorization: auth, host: 'attacker.example.com' }).res.statusCode, 403);
  for (const foreign of ['https://attacker.example.com', 'null', 'https://preview.example.com:444']) {
    assert.equal(check({ authorization: auth, origin: foreign }).res.statusCode, 403);
  }
  assert.equal(check({ authorization: auth, 'sec-fetch-site': 'cross-site' }).res.statusCode, 403);
  assert.equal(check({ authorization: auth }).accepted, true);
  const valid = check({ authorization: auth, origin });
  assert.equal(valid.accepted, true);
  assert.equal(valid.req.headers.origin, localOrigin);
  assert.equal(valid.req.headers.host, '127.0.0.1:5188');
  assert.equal(valid.req.headers.authorization, undefined);
  assert.throws(() => accessGate('http://preview.example.com', password));
  assert.throws(() => accessGate(`${origin}/unexpected`, password));
  assert.throws(() => accessGate(origin, 'short'));

  // Handoff (ADR-041): one-time link -> session cookie; cookie or Basic both pass the same checks.
  const secret = 'ab'.repeat(32);
  const handoffGate = accessGate(origin, password, { secret, controlOrigin: 'https://raytone.example.com' });
  const via = (headers, url = '/', method = 'GET') => {
    const req = { method, url, headers: { host: 'preview.example.com', ...headers } };
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body = b; } };
    let accepted = false;
    handoffGate(req, res, () => { accepted = true; });
    return { req, res, accepted };
  };
  const link = (token) => `${HANDOFF_PATH}?t=${encodeURIComponent(token)}`;
  assert.equal(via({}).res.statusCode, 401);
  assert.equal(via({}).res.headers['www-authenticate'], undefined, 'no Basic prompt once handoff is on');
  assert.match(via({}).res.body, /raytone\.example\.com\/welcome/);
  assert.equal(via({ authorization: auth }).accepted, true, 'Basic still works');
  const token = issueHandoff(secret, origin);
  const entered = via({ 'sec-fetch-site': 'cross-site' }, link(token));
  assert.equal(entered.res.statusCode, 200);
  const cookie = entered.res.headers['set-cookie'];
  assert.match(cookie, /^__Host-rtb_session=[^;]+; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(via({}, link(token)).res.statusCode, 401, 'a token works once');
  assert.equal(via({}, link(issueHandoff(secret, 'https://other.example.com'))).res.statusCode, 401, 'bound to this origin');
  assert.equal(via({}, link(issueHandoff('cd'.repeat(32), origin))).res.statusCode, 401, 'signed with this secret');
  assert.equal(via({}, link(issueHandoff(secret, origin, Date.now() - 61_000))).res.statusCode, 401, 'expired');
  assert.equal(via({}, link(issueHandoff(secret, origin)), 'POST').res.statusCode, 404);
  const sessionCookie = cookie.split(';')[0];
  const withCookie = via({ cookie: `other=1; ${sessionCookie}`, origin });
  assert.equal(withCookie.accepted, true);
  assert.equal(withCookie.req.headers.origin, localOrigin);
  assert.equal(via({ cookie: sessionCookie, 'sec-fetch-site': 'cross-site' }).res.statusCode, 403, 'cookie requests keep the CSRF check');
  assert.equal(via({ cookie: sessionCookie, origin: 'https://attacker.example.com' }).res.statusCode, 403);
  assert.equal(via({ cookie: `${sessionCookie.slice(0, -2)}xx` }).res.statusCode, 401, 'tampered cookie');
  assert.equal(via({ cookie: `__Host-rtb_session=${issueSession(secret, Date.now() - 8 * 24 * 3600_000)}` }).res.statusCode, 401, 'expired cookie');
  assert.equal(via({ cookie: `__Host-rtb_session=${issueSession('cd'.repeat(32))}` }).res.statusCode, 401, 'foreign secret');
  const noHandoff = check({ cookie: sessionCookie });
  assert.equal(noHandoff.res.statusCode, 401, 'cookies mean nothing without a handoff secret');
  assert.throws(() => accessGate(origin, password, { secret: 'short' }));
  console.log('PASS: cloud authentication, exact host/origin, CSRF rejection, trusted normalization, handoff sessions.');
} else {
  const handoffSecret = process.env.RAYTONEBOT_HANDOFF_SECRET || undefined;
  const trustProxy = process.env.RAYTONEBOT_TRUST_PROXY_ORIGIN === '1';
  const guard = accessGate(process.env.RAYTONEBOT_PUBLIC_ORIGIN, process.env.RAYTONEBOT_PASSWORD,
    handoffSecret ? { secret: handoffSecret, controlOrigin: process.env.RAYTONEBOT_CONTROL_ORIGIN || undefined } : undefined,
    { trustProxy });
  // The gate holds the password and handoff secret now; agent tools inherit this process's environment.
  delete process.env.RAYTONEBOT_PASSWORD;
  delete process.env.RAYTONEBOT_HANDOFF_SECRET;
  delete process.env.RAYTONEBOT_TRUST_PROXY_ORIGIN;
  await preview({
    preview: {
      host: '0.0.0.0', port, strictPort: true, cors: false,
      allowedHosts: [new URL(process.env.RAYTONEBOT_PUBLIC_ORIGIN).hostname],
    },
    plugins: [{
      name: 'raytonebot-cloud-access',
      enforce: 'pre',
      configurePreviewServer(server) { server.middlewares.use(guard); },
    }],
  });
  console.log(`RaytoneBot protected preview listening on port ${port}`);
}
