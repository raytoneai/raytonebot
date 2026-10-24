import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./http.js";
import { compareAndSet, getStore, K, parse } from "./store.js";

/** Retry against the latest record; a page write may never clear a concurrent revocation. */
export async function updateKey(id, change, { allowRevoked = false } = {}) {
  const store = getStore();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const raw = await store.cmd("GET", K.key(id));
    const current = parse(raw);
    if (!current || (!allowRevoked && current.revokedAt)) throw new HttpError(401, "这个 key 已失效");
    const next = change(current);
    if (next === current) return { record: current, changed: false };
    if (await compareAndSet(store, K.key(id), raw, JSON.stringify(next))) return { record: next, changed: true };
  }
  throw new HttpError(409, "设置已被其他请求修改，请重试");
}

// Access keys: RTB-XXXXX-XXXXX-XXXXX-XXXXX, 100 random bits in Crockford base32 so they survive
// being read aloud or retyped. Only a key's hash is stored; the key itself is printed once, by
// the control CLI that made it. Shared by the console and control/ so both hash the same way.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 20;

export function newKey() {
  const bytes = randomBytes(LENGTH);
  const body = Array.from(bytes, (byte) => ALPHABET[byte & 31]).join("");
  return `RTB-${body.match(/.{5}/g).join("-")}`;
}

/** The 20 key characters with dashes, case and look-alikes forgiven; undefined if it cannot be a key. */
export function normalizeKey(input) {
  if (typeof input !== "string" || input.length > 64) return undefined;
  let body = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/[O]/g, "0").replace(/[IL]/g, "1");
  if (body.length === LENGTH + 3 && body.startsWith("RTB")) body = body.slice(3);
  return body.length === LENGTH && [...body].every((char) => ALPHABET.includes(char)) ? body : undefined;
}

/** A key's stable id: what the console stores, what the control service records as the bot's owner. */
export function keyId(input) {
  const body = normalizeKey(input);
  return body && createHash("sha256").update(`rtb-key:${body}`).digest("hex").slice(0, 24);
}

/** The last group, enough for a person to tell their keys apart. */
export const keyHint = (input) => normalizeKey(input)?.slice(-5);
