import { issueHandoff } from "../../lib/crypto.js";
import { enqueue, load, pageView, ping } from "../../lib/bot.js";
import { assertSameOrigin, HttpError, json, readJson, route, signedIn } from "../../lib/http.js";
import { getStore } from "../../lib/store.js";
import { updateKey } from "../../lib/keys.js";

// The page's actions on its one bot. Anything that needs the sandbox platform (create, wake,
// renew, back up) is queued for the control service; entering a bot that already answers is
// signed here, so a running bot stays reachable while the control service is away.

const HANDOFF_PATH = "/__raytone/handoff";

const action = (request) => new URL(request.url).pathname.split("/").filter(Boolean).at(-1);

export const GET = route(async (request) => {
  if (action(request) !== "ping") throw new HttpError(404, "Not found");
  const record = await signedIn(request);
  const { access } = await load(record.id);
  if (!access) throw new HttpError(409, "bot 还没有准备好");
  return json(200, await ping(access));
});

export const POST = route(async (request) => {
  assertSameOrigin(request);
  const record = await signedIn(request);
  const store = getStore();
  const body = await readJson(request, 1024);
  const state = await load(record.id);
  const { bot, access, control } = state;

  switch (action(request)) {
    case "claim": {
      const { record: claimed, changed } = await updateKey(record.id, current => current.claimedAt ? current : { ...current, claimedAt: Date.now() });
      if (!changed) return json(200, pageView(claimed, state));
      await enqueue(record.id, "claim");
      return json(201, pageView(claimed, state));
    }
    case "retry":
      if (bot?.status !== "failed") throw new HttpError(409, "没有需要重试的步骤");
      await enqueue(record.id, "retry");
      return json(202, { queued: true, controlOnline: control.online });
    case "backup":
      if (bot?.status !== "ready") throw new HttpError(409, "bot 还没有准备好");
      await enqueue(record.id, "backup");
      return json(202, { queued: true, controlOnline: control.online });
    case "settings": {
      if (typeof body.keepAwake !== "boolean") throw new HttpError(400, "keepAwake must be true or false");
      const { record: updated } = await updateKey(record.id, current => ({ ...current, keepAwake: body.keepAwake }));
      await enqueue(record.id, "settings", { keepAwake: body.keepAwake });
      return json(200, pageView(updated, state));
    }
    case "enter": {
      if (bot?.status !== "ready" || !access?.handoffSecret) throw new HttpError(409, "bot 还没有准备好");
      const health = await ping(access);
      // One request per minute is enough: it wakes, or renews and counts as activity.
      const first = await store.cmd("SET", `rtb:enter:${record.id}`, "1", "NX", "EX", 60);
      if (first) await enqueue(record.id, "enter");
      if (health.ok) {
        return json(200, { url: `${access.url}${HANDOFF_PATH}?t=${encodeURIComponent(issueHandoff(access.handoffSecret, access.url))}` });
      }
      if (!control.online) throw new HttpError(503, "bot 正在休眠，负责唤醒的管理服务暂时离线，请稍后再试");
      return json(202, { waking: true });
    }
    default:
      throw new HttpError(404, "Not found");
  }
});
