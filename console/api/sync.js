import { bearerMatches, sealAccess } from "../lib/crypto.js";
import { HttpError, json, readJson, route } from "../lib/http.js";
import { getStore, K, parse } from "../lib/store.js";

// The control service's one call (control/relay.ts), authenticated with CONTROL_SYNC_TOKEN:
// it reports bots that changed and takes the queued page requests. With `full` it also gets every
// claimed key, to catch up after it was away. Storage commands are counted per call, so an idle
// sync costs one LPOP.

export const POST = route(async (request) => {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CONTROL_SYNC_TOKEN)) throw new HttpError(401, "Unauthorized");
  const store = getStore();
  const body = await readJson(request, 1024 * 1024);
  const reports = Array.isArray(body.bots) ? body.bots.filter((bot) => typeof bot?.key === "string") : [];

  const writes = [];
  if (body.heartbeat) writes.push(["SET", K.control, String(Date.now())]);
  if (reports.length) {
    // Only keys this console issued; a bot adopted for another owner stays private to the host.
    const known = await store.cmd("MGET", ...reports.map((bot) => K.key(bot.key)));
    reports.forEach((bot, index) => {
      if (!known[index]) return;
      if (bot.view) writes.push(["SET", K.bot(bot.key), JSON.stringify({ ...bot.view, reportedAt: Date.now() })]);
      if (bot.access) writes.push(["SET", K.access(bot.key), sealAccess(bot.access)]);
    });
  }
  if (writes.length) await store.pipe(writes);

  const commands = ((await store.cmd("LPOP", K.queue, 100)) ?? []).map(parse).filter(Boolean);
  let keys;
  if (body.full) {
    const ids = await store.cmd("SMEMBERS", K.keys);
    const records = ids.length ? await store.cmd("MGET", ...ids.map(K.key)) : [];
    keys = records.map(parse).filter((record) => record?.claimedAt)
      .map(({ id, claimedAt, keepAwake, revokedAt }) => ({ id, claimedAt, keepAwake, revokedAt }));
  }
  return json(200, { commands, keys });
});
