import { bearerMatches } from "../../lib/crypto.js";
import { HttpError, json, readJson, route } from "../../lib/http.js";
import { getStore, K, parse } from "../../lib/store.js";
import { updateKey } from "../../lib/keys.js";

// Issuing and revoking access keys, for the control CLI (`node control/server.ts keys …`) with the
// same CONTROL_SYNC_TOKEN. The CLI generates keys locally and sends only their ids.

const authorize = (request) => {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CONTROL_SYNC_TOKEN)) throw new HttpError(401, "Unauthorized");
};

export const GET = route(async (request) => {
  authorize(request);
  const store = getStore();
  const ids = await store.cmd("SMEMBERS", K.keys);
  if (!ids.length) return json(200, { keys: [] });
  const [records, bots] = await Promise.all([store.cmd("MGET", ...ids.map(K.key)), store.cmd("MGET", ...ids.map(K.bot))]);
  const keys = records.map((text, index) => {
    const record = parse(text);
    const bot = parse(bots[index]);
    return record && { ...record, bot: bot && { status: bot.status, sandbox: bot.sandbox?.state, reportedAt: bot.reportedAt } };
  }).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  return json(200, { keys });
});

export const POST = route(async (request) => {
  authorize(request);
  const store = getStore();
  const body = await readJson(request);
  if (Array.isArray(body.create)) {
    const create = body.create.filter((key) => /^[0-9a-f]{24}$/.test(key?.id ?? "")).slice(0, 500);
    const now = Date.now();
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : undefined;
    const replies = await store.pipe(create.flatMap((key) => [
      ["SET", K.key(key.id), JSON.stringify({ id: key.id, hint: String(key.hint ?? "").slice(0, 5), label, createdAt: now }), "NX"],
      ["SADD", K.keys, key.id],
    ]));
    return json(201, { created: replies.filter((_, index) => index % 2 === 0 && replies[index] === "OK").length });
  }
  if (typeof body.revoke === "string") {
    const ids = await store.cmd("SMEMBERS", K.keys);
    const matches = ids.filter((id) => id.startsWith(body.revoke.toLowerCase()));
    if (matches.length !== 1) throw new HttpError(matches.length ? 409 : 404, matches.length ? "More than one key matches" : "No such key");
    await updateKey(matches[0], current => ({ ...current, revokedAt: current.revokedAt || Date.now() }), { allowRevoked: true });
    return json(200, { revoked: matches[0] });
  }
  throw new HttpError(400, "Send create or revoke");
});
