import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import {
  HANDOFF_PATH, SESSION_COOKIE, SESSION_TTL_MS, assertHandoffSecret, handoffRedeemer, issueHandoff, issueSession,
  readCookie, sessionValid,
} from './handoff.mjs';

const port = 5188;
const localOrigin = `http://127.0.0.1:${port}`;
const digest = (value) => createHash('sha256').update(value).digest();
const HEADER_LOG_MAX_BYTES = 256 * 1024;
const HEADER_LOG_MAX_VALUE_LENGTH = 256;
const HEADER_LOG_MAX_URL_LENGTH = 8 * 1024;
const HEADER_LOG_MAX_PATHNAME_LENGTH = 1024;

const headerValue = (headers, name) => {
  const value = headers && typeof headers === 'object' ? headers[name] : undefined;
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string' || first.length > HEADER_LOG_MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(first)) return undefined;
  return first.trim() || undefined;
};

const safeHost = (raw, forwarded = false) => {
  if (!raw || (!forwarded && raw.includes(','))) return undefined;
  const candidate = (forwarded ? raw.split(',')[0] : raw).trim();
  if (!candidate) return undefined;
  try {
    const parsed = new URL(`https://${candidate}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.host;
  } catch {
    return undefined;
  }
};

const safeOrigin = (raw) => {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
};

const appendHeaderDiagnostic = (headerLog, req, baseOrigin) => {
  if (!headerLog) return;
  try {
    const rawUrl = req?.url;
    let pathname = '/';
    if (rawUrl !== undefined && rawUrl !== null) {
      if (typeof rawUrl !== 'string' || rawUrl.length > HEADER_LOG_MAX_URL_LENGTH) pathname = '<invalid>';
      else {
        try { pathname = new URL(rawUrl || '/', baseOrigin).pathname || '/'; } catch { pathname = '<invalid>'; }
      }
    }
    if (pathname.length > HEADER_LOG_MAX_PATHNAME_LENGTH) pathname = `${pathname.slice(0, HEADER_LOG_MAX_PATHNAME_LENGTH - 1)}…`;
    const requestHeaders = req?.headers;
    const forwardedPort = headerValue(requestHeaders, 'x-forwarded-port')?.split(',')[0].trim();
    const forwardedPortNumber = Number(forwardedPort);
    const headers = {};
    for (const [name, value] of [
      ['host', safeHost(headerValue(requestHeaders, 'host'))],
      ['origin', safeOrigin(headerValue(requestHeaders, 'origin'))],
      ['x-forwarded-host', safeHost(headerValue(requestHeaders, 'x-forwarded-host'), true)],
      ['x-forwarded-port', forwardedPort && /^\d{1,5}$/.test(forwardedPort) && forwardedPortNumber >= 1 && forwardedPortNumber <= 65_535 ? forwardedPort : undefined],
    ]) if (value !== undefined) headers[name] = value;
    const record = { pathname, headers };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const currentStat = statSync(headerLog, { throwIfNoEntry: false });
    if (currentStat && !currentStat.isFile()) return;
    if ((currentStat?.size ?? 0) < 0 || (currentStat?.size ?? 0) + lineBytes > HEADER_LOG_MAX_BYTES) return;
    appendFileSync(headerLog, line, 'utf8');
  } catch { /* diagnostics must never break serving */ }
};

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:16px/1.6 sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem">${body}</body></html>`;

// Protect Pi and static assets before their route handlers.
// Only this authenticated boundary may normalize cloud requests for the local Pi host.
// With a handoff secret (ADR-041) the welcome page's one-time link becomes a session cookie;
// Basic Auth stays for operators and the control service's own health checks.
// `trustProxy` is for a reverse proxy that terminates TLS and forwards the public Host in
// x-forwarded-host (the AgentMatrix PreviewProxy). It is opt-in and only safe when the proxy
// overwrites that header: a directly reachable server would let a caller forge it.
function accessGate(publicOrigin, password, handoff, { trustProxy = false, previewIngress = false } = {}) {
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
    // Bounded, opt-in diagnostic for adapting to a new reverse proxy. Never record query
    // strings, credentials, cookies, or arbitrary headers from an unauthenticated request.
    appendHeaderDiagnostic(headerLog, req, origin.origin);
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
    // The platform's PreviewProxy is the only ingress and strips Authorization, Cookie and
    // custom headers. Its short-lived signed URL is then the credential: an explicit opt-in
    // accepts a request that provably came through that proxy, while Basic Auth and direct
    // requests keep working as before. Never enable this on a directly reachable server.
    const viaPreviewIngress = previewIngress && trustProxy && Boolean(forwardedPort) &&
      req.headers.host === new URL(localOrigin).host;
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
    if (!viaPreviewIngress && !timingSafeEqual(digest(authorization), expected) &&
        !(session && sessionValid(secret, session))) {
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
  const previewGate = accessGate(origin, password, undefined, { trustProxy: true, previewIngress: true });
  const viaPreview = (headers) => {
    const req = { method: 'GET', url: '/', headers: { host: '127.0.0.1:5188', ...headers } };
    const res = { statusCode: 200, setHeader() {}, end() {} };
    let accepted = false;
    previewGate(req, res, () => { accepted = true; });
    return { req, res, accepted };
  };
  assert.equal(viaPreview({ 'x-forwarded-port': '443' }).accepted, true, 'signed preview URL is the credential');
  assert.equal(viaPreview({}).res.statusCode, 403, 'a direct request with a rewritten host is rejected');
  assert.equal(viaPreview({ host: new URL(origin).host }).res.statusCode, 401, 'a direct request still needs credentials');
  assert.equal(viaPreview({ 'x-forwarded-port': '443', origin: 'https://attacker.example.com' }).res.statusCode, 403);
  assert.equal(viaPreview({ 'x-forwarded-port': '443', 'sec-fetch-site': 'cross-site' }).res.statusCode, 403);
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

  // Opt-in header diagnostics are pathname-only and use a strict metadata allowlist.
  const diagnosticDir = mkdtempSync(join(tmpdir(), 'raytonebot-cloud-check-'));
  const diagnosticLog = join(diagnosticDir, 'headers.jsonl');
  const previousHeaderLog = process.env.RAYTONEBOT_HEADER_LOG;
  try {
    process.env.RAYTONEBOT_HEADER_LOG = diagnosticLog;
    const diagnosticGate = accessGate(origin, password, { secret, controlOrigin: 'https://raytone.example.com' }, { trustProxy: true });
    const diagnosticVia = (headers, url = '/', method = 'GET') => {
      const req = { method, url, headers: { host: 'preview.example.com', ...headers } };
      const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body = b; } };
      let accepted = false;
      diagnosticGate(req, res, () => { accepted = true; });
      return { req, res, accepted };
    };
    const customSecret = 'custom-header-secret';
    const ordinaryQuerySecret = 'ordinary-query-secret';
    assert.equal(diagnosticVia({ authorization: auth, 'x-raytone-secret': customSecret }, `/?q=${ordinaryQuerySecret}`).accepted, true);

    const loggedToken = issueHandoff(secret, origin);
    const loggedEntry = diagnosticVia({ 'sec-fetch-site': 'cross-site', 'x-raytone-secret': customSecret }, link(loggedToken));
    assert.equal(loggedEntry.res.statusCode, 200);
    const loggedSessionCookie = loggedEntry.res.headers['set-cookie'].split(';')[0];
    const sessionQuerySecret = 'session-query-secret';
    assert.equal(diagnosticVia({ cookie: `other=1; ${loggedSessionCookie}`, origin, 'x-raytone-secret': customSecret }, `/?q=${sessionQuerySecret}`).accepted, true);

    const proxyQuerySecret = 'proxy-query-secret';
    assert.equal(diagnosticVia({
      host: '127.0.0.1:5188',
      'x-forwarded-host': new URL(origin).host,
      'x-forwarded-port': '443',
      authorization: auth,
      'x-raytone-secret': customSecret,
    }, `/assets/app.js?q=${proxyQuerySecret}`).accepted, true);

    const invalidOriginSecret = 'invalid-origin-secret';
    assert.equal(diagnosticVia({
      authorization: auth,
      origin: `${origin}?q=${invalidOriginSecret}`,
      'x-raytone-secret': customSecret,
    }, `/invalid?q=${invalidOriginSecret}`).res.statusCode, 403);
    const malformedUrlSecret = 'malformed-url-secret';
    assert.equal(diagnosticVia({ authorization: auth }, `http://[bad?q=${malformedUrlSecret}`).accepted, true);

    const diagnosticText = readFileSync(diagnosticLog, 'utf8');
    for (const sensitive of [auth, loggedToken, loggedSessionCookie, customSecret, ordinaryQuerySecret,
      sessionQuerySecret, proxyQuerySecret, invalidOriginSecret, malformedUrlSecret]) {
      assert.equal(diagnosticText.includes(sensitive), false, `diagnostic must not contain ${sensitive}`);
    }
    const diagnosticRecords = diagnosticText.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(diagnosticRecords.every((record) => !('url' in record)), 'diagnostic records contain no raw URL');
    assert.ok(diagnosticRecords.every((record) => !('authorization' in record.headers) && !('cookie' in record.headers)),
      'diagnostic records contain no credentials');
    const proxyRecord = diagnosticRecords.find((record) => record.pathname === '/assets/app.js');
    assert.deepEqual(proxyRecord?.headers, {
      host: '127.0.0.1:5188',
      'x-forwarded-host': 'preview.example.com',
      'x-forwarded-port': '443',
    }, 'diagnostic keeps the required proxy metadata only');
    const invalidOriginRecord = diagnosticRecords.find((record) => record.pathname === '/invalid');
    assert.equal(invalidOriginRecord?.headers.origin, undefined, 'invalid origins are not copied into diagnostics');

    const fullLog = join(diagnosticDir, 'full.log');
    writeFileSync(fullLog, Buffer.alloc(HEADER_LOG_MAX_BYTES - 1, 'x'));
    process.env.RAYTONEBOT_HEADER_LOG = fullLog;
    const boundedGate = accessGate(origin, password);
    const boundedReq = { method: 'GET', url: '/', headers: { host: 'preview.example.com', authorization: auth } };
    const boundedRes = { statusCode: 200, setHeader() {}, end() {} };
    let boundedAccepted = false;
    boundedGate(boundedReq, boundedRes, () => { boundedAccepted = true; });
    assert.equal(boundedAccepted, true);
    assert.equal(statSync(fullLog).size, HEADER_LOG_MAX_BYTES - 1, 'diagnostic file size is bounded');

    process.env.RAYTONEBOT_HEADER_LOG = join(diagnosticDir, 'missing', 'headers.jsonl');
    const failingLogGate = accessGate(origin, password);
    const failingLogReq = { method: 'GET', url: '/', headers: { host: 'preview.example.com', authorization: auth } };
    const failingLogRes = { statusCode: 200, setHeader() {}, end() {} };
    let failingLogAccepted = false;
    failingLogGate(failingLogReq, failingLogRes, () => { failingLogAccepted = true; });
    assert.equal(failingLogAccepted, true, 'diagnostic write failures do not affect serving');
  } finally {
    if (previousHeaderLog === undefined) delete process.env.RAYTONEBOT_HEADER_LOG;
    else process.env.RAYTONEBOT_HEADER_LOG = previousHeaderLog;
    rmSync(diagnosticDir, { recursive: true, force: true });
  }
  assert.throws(() => accessGate(origin, password, { secret: 'short' }));
  console.log('PASS: cloud authentication, exact host/origin, CSRF rejection, trusted normalization, handoff sessions, redacted bounded diagnostics.');
} else {
  const handoffSecret = process.env.RAYTONEBOT_HANDOFF_SECRET || undefined;
  const trustProxy = process.env.RAYTONEBOT_TRUST_PROXY_ORIGIN === '1';
  const previewIngress = process.env.RAYTONEBOT_PREVIEW_INGRESS === '1';
  const guard = accessGate(process.env.RAYTONEBOT_PUBLIC_ORIGIN, process.env.RAYTONEBOT_PASSWORD,
    handoffSecret ? { secret: handoffSecret, controlOrigin: process.env.RAYTONEBOT_CONTROL_ORIGIN || undefined } : undefined,
    { trustProxy, previewIngress });
  // The gate holds the password and handoff secret now; agent tools inherit this process's environment.
  delete process.env.RAYTONEBOT_PASSWORD;
  delete process.env.RAYTONEBOT_HANDOFF_SECRET;
  delete process.env.RAYTONEBOT_TRUST_PROXY_ORIGIN;
  delete process.env.RAYTONEBOT_PREVIEW_INGRESS;
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
