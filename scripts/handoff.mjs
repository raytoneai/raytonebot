// Entering a bot from the welcome page (ADR-041). The control service signs a one-time handoff
// token with the bot's own secret; the bot's access gate (cloud-preview.mjs) redeems it for a
// session cookie. Shared by both sides so the format has one source of truth. Node-only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HANDOFF_PATH = '/__raytone/handoff';
export const SESSION_COOKIE = '__Host-rtb_session';
export const HANDOFF_TTL_MS = 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

const sign = (secret, purpose, payload) => createHmac('sha256', secret).update(`${purpose}.${payload}`).digest('base64url');

function seal(secret, purpose, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(secret, purpose, payload)}`;
}

/** The claims of a token signed for `purpose` that has not expired; undefined otherwise. */
function unseal(secret, purpose, token, now) {
  if (typeof token !== 'string' || token.length > 1024) return undefined;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(secret, purpose, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return undefined; }
  return claims && typeof claims.exp === 'number' && claims.exp > now ? claims : undefined;
}

export function assertHandoffSecret(secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64,}$/.test(secret)) throw new Error('The handoff secret must be 32+ random bytes in hex');
}

export const newHandoffSecret = () => randomBytes(32).toString('hex');

/** A link token for the bot at `origin`, valid once and for a minute. */
export function issueHandoff(secret, origin, now = Date.now()) {
  return seal(secret, 'handoff', { sub: origin, exp: now + HANDOFF_TTL_MS, n: randomBytes(12).toString('base64url') });
}

/** Redeems handoff tokens for `origin`; each nonce works once while it is still unexpired. */
export function handoffRedeemer(secret, origin) {
  const used = new Map();
  return (token, now = Date.now()) => {
    const claims = unseal(secret, 'handoff', token, now);
    if (!claims || claims.sub !== origin || typeof claims.n !== 'string' || claims.exp > now + HANDOFF_TTL_MS) return false;
    for (const [nonce, exp] of used) if (exp <= now) used.delete(nonce);
    if (used.has(claims.n)) return false;
    used.set(claims.n, claims.exp);
    return true;
  };
}

export const issueSession = (secret, now = Date.now()) => seal(secret, 'session', { exp: now + SESSION_TTL_MS });

export const sessionValid = (secret, token, now = Date.now()) => unseal(secret, 'session', token, now) !== undefined;

/** The value of cookie `name` in a Cookie header, if present. */
export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
