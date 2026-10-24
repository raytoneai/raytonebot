import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Everything the console signs or seals, all derived from one CONSOLE_SECRET.

function secret() {
  const value = process.env.CONSOLE_SECRET;
  if (!value || value.length < 32) throw new Error("Set CONSOLE_SECRET (32+ random characters)");
  return value;
}

const derive = (purpose) => createHmac("sha256", secret()).update(`raytone-console:${purpose}`).digest();
const mac = (keyBytes, purpose, payload) => createHmac("sha256", keyBytes).update(`${purpose}.${payload}`).digest("base64url");

function seal(keyBytes, purpose, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(keyBytes, purpose, payload)}`;
}

function unseal(keyBytes, purpose, token, now) {
  if (typeof token !== "string" || token.length > 1024) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = Buffer.from(mac(keyBytes, purpose, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
  return claims && typeof claims.exp === "number" && claims.exp > now ? claims : undefined;
}

export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export const issueSession = (id, now = Date.now()) => seal(derive("session"), "session", { k: id, exp: now + SESSION_TTL_MS });

export function sessionKey(token, now = Date.now()) {
  const claims = unseal(derive("session"), "session", token, now);
  return typeof claims?.k === "string" ? claims.k : undefined;
}

/** A bot's password and handoff secret, encrypted at rest so a storage dump alone opens nothing. */
export function sealAccess(access) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive("access"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(access), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function openAccess(sealed) {
  if (typeof sealed !== "string") return undefined;
  try {
    const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", derive("access"), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A one-time link token for the bot at `origin`, in the format scripts/handoff.mjs redeems
 * (the bot's gate checks it with the same secret). Valid for a minute.
 */
export function issueHandoff(handoffSecret, origin, now = Date.now()) {
  return seal(handoffSecret, "handoff", { sub: origin, exp: now + 60_000, n: randomBytes(12).toString("base64url") });
}

export function bearerMatches(header, expected) {
  if (!expected || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
