import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { preview } from 'vite';

const port = 5188;
const localOrigin = `http://127.0.0.1:${port}`;
const digest = (value) => createHash('sha256').update(value).digest();

// Protect Pi and static assets before their route handlers.
// Only this authenticated boundary may normalize cloud requests for the local Pi host.
function accessGate(publicOrigin, password) {
  const origin = new URL(publicOrigin);
  assert.equal(origin.protocol, 'https:', 'RAYTONEBOT_PUBLIC_ORIGIN must use HTTPS');
  assert.equal(origin.href, `${origin.origin}/`, 'Use a bare public origin');
  assert.ok(password?.length >= 24, 'RAYTONEBOT_PASSWORD must contain at least 24 characters');
  const expected = digest(`Basic ${Buffer.from(`raytonebot:${password}`).toString('base64')}`);

  return (req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    const reject = (status, message) => { res.statusCode = status; res.end(message); };
    if (req.headers.host !== origin.host) return reject(403, 'Unexpected host');
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (!timingSafeEqual(digest(authorization), expected)) {
      res.setHeader('www-authenticate', 'Basic realm="RaytoneBot", charset="UTF-8"');
      return reject(401, 'Authentication required');
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
  console.log('PASS: cloud authentication, exact host/origin, CSRF rejection, trusted normalization.');
} else {
  const guard = accessGate(process.env.RAYTONEBOT_PUBLIC_ORIGIN, process.env.RAYTONEBOT_PASSWORD);
  // The gate holds the password now; agent tools inherit this process's environment.
  delete process.env.RAYTONEBOT_PASSWORD;
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
