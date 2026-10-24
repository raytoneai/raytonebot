import { sessionKey } from "./crypto.js";
import { getStore, K, parse } from "./store.js";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

/** Wraps a handler so thrown HttpErrors become JSON and anything else a generic 500. */
export const route = (handler) => async (request) => {
  try {
    return await handler(request);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "console.error", path: new URL(request.url).pathname, error: String(error?.message ?? error) }));
    return json(500, { error: "出了点问题，请重试" });
  }
};

export async function readJson(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "Request too large");
  if (!text) return {};
  const body = parse(text);
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid JSON");
  return body;
}

/** Page POSTs: same-origin JSON only, so another site or a plain form cannot drive them. */
export function assertSameOrigin(request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(403, "Cross-origin request");
  if (!String(request.headers.get("content-type")).startsWith("application/json")) throw new HttpError(415, "JSON only");
}

export const COOKIE = "rtb_console";

export function readCookie(request, name = COOKIE) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function cookieHeader(request, value, maxAgeS) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

/** The signed-in key's record, re-read every request so a revoked key stops working at once. */
export async function signedIn(request) {
  const id = sessionKey(readCookie(request));
  if (!id) throw new HttpError(401, "请输入访问 key");
  const record = parse(await getStore().cmd("GET", K.key(id)));
  if (!record || record.revokedAt) throw new HttpError(401, "这个 key 已失效");
  return record;
}

export const clientIp = (request) =>
  request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
