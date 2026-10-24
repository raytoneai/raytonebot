import assert from "node:assert/strict";
import { test } from "node:test";
import { POST as action } from "../console/api/bot/[action].js";
import { POST as admin } from "../console/api/admin/keys.js";
import { GET as getBot } from "../console/api/bot.js";
import { issueSession } from "../console/lib/crypto.js";
import { memoryStore, setStore, K } from "../console/lib/store.js";

test("an in-flight claim or settings save cannot reactivate a revoked console key", async (t) => {
  const previousSecret = process.env.CONSOLE_SECRET;
  const previousToken = process.env.CONTROL_SYNC_TOKEN;
  process.env.CONSOLE_SECRET = "review-test-secret-with-at-least-32-characters";
  process.env.CONTROL_SYNC_TOKEN = "review-test-token";
  try {
    for (const [kind, boundary] of [["claim", "MGET"], ["settings", "MGET"], ["claim", "EVAL"], ["settings", "EVAL"]]) {
      const store = memoryStore();
      const id = "123456789012345678901234";
      await store.cmd("SET", K.key(id), JSON.stringify({ id }));
      await store.cmd("SADD", K.keys, id);
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const began = new Promise<void>(resolve => { entered = resolve; });
      let paused = false;
      setStore({ ...store, async cmd(...args: unknown[]) {
        if (!paused && args[0] === boundary) { paused = true; entered(); await waiting; }
        return store.cmd(...args);
      } });
      const headers = { origin: "https://console.example", "content-type": "application/json", cookie: `rtb_console=${issueSession(id)}` };
      const pending = action(new Request(`https://console.example/api/bot/${kind}`, {
        method: "POST", headers, body: JSON.stringify({ keepAwake: true }),
      }));
      await began;
      try {
        const revoked = await admin(new Request("https://console.example/api/admin/keys", {
          method: "POST", headers: { authorization: "Bearer review-test-token" }, body: JSON.stringify({ revoke: id }),
        }));
        assert.equal(revoked.status, 200);
      } finally { release(); }
      assert.equal((await pending).status, 401, `${kind} must reject the now-revoked key`);
      assert.equal((await getBot(new Request("https://console.example/api/bot", { headers }))).status, 401);
      assert.equal(await store.cmd("LPOP", K.queue), null, "rejected changes must not reach the control service");
    }
    await t.test("concurrent claims enqueue once and normal settings remain editable", async () => {
      const store = memoryStore(); setStore(store);
      const id = "123456789012345678901234";
      await store.cmd("SET", K.key(id), JSON.stringify({ id }));
      const headers = { origin: "https://console.example", "content-type": "application/json", cookie: `rtb_console=${issueSession(id)}` };
      const post = (kind: string, body = {}) => action(new Request(`https://console.example/api/bot/${kind}`, { method: "POST", headers, body: JSON.stringify(body) }));
      const claims = await Promise.all([post("claim"), post("claim")]);
      assert.deepEqual(claims.map(response => response.status).sort(), [200, 201]);
      assert.equal(JSON.parse(await store.cmd("LPOP", K.queue)).kind, "claim");
      assert.equal(await store.cmd("LPOP", K.queue), null);
      const settings = await post("settings", { keepAwake: true });
      assert.equal(settings.status, 200);
      const view = await (await getBot(new Request("https://console.example/api/bot", { headers }))).json();
      assert.equal(view.key.keepAwake, true);
      assert.ok(view.key.claimedAt);
    });
  } finally {
    setStore(undefined);
    if (previousSecret === undefined) delete process.env.CONSOLE_SECRET; else process.env.CONSOLE_SECRET = previousSecret;
    if (previousToken === undefined) delete process.env.CONTROL_SYNC_TOKEN; else process.env.CONTROL_SYNC_TOKEN = previousToken;
  }
});
