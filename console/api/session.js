import { issueSession, SESSION_TTL_MS } from "../lib/crypto.js";
import { assertSameOrigin, clientIp, cookieHeader, HttpError, json, readJson, route } from "../lib/http.js";
import { keyId } from "../lib/keys.js";
import { getStore, K, parse } from "../lib/store.js";

// Signing in with an access key, and signing out. Keys carry 100 random bits; the per-address
// limit only keeps a typo loop or a scanner from burning storage commands.

const ATTEMPTS = 10;
const WINDOW_S = 600;

export const POST = route(async (request) => {
  assertSameOrigin(request);
  const store = getStore();
  const limit = K.limit(clientIp(request));
  const [attempts] = await store.pipe([["INCR", limit], ["EXPIRE", limit, WINDOW_S]]);
  if (attempts > ATTEMPTS) throw new HttpError(429, "尝试次数太多，请十分钟后再试");
  const { key } = await readJson(request, 1024);
  const id = keyId(key);
  if (!id) throw new HttpError(400, "key 的格式不对，应类似 RTB-XXXXX-XXXXX-XXXXX-XXXXX");
  const record = parse(await store.cmd("GET", K.key(id)));
  if (!record) throw new HttpError(401, "没有找到这个 key");
  if (record.revokedAt) throw new HttpError(401, "这个 key 已失效");
  return json(200, { ok: true }, { "set-cookie": cookieHeader(request, issueSession(id), SESSION_TTL_MS / 1000) });
});

export const DELETE = route(async (request) => {
  assertSameOrigin(request);
  return json(200, { ok: true }, { "set-cookie": cookieHeader(request, "", 0) });
});
