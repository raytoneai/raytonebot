import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeControlPlaneEntry, ControlPlaneSession, CONTROL_CSRF_HEADER } from "./controlPlaneSession.ts";

const receipt = (developerScope = false) => ({ authenticated: true, csrfToken: "test-csrf", expiresAt: Date.now() + 60_000, developerScope });

test("one-time fragment is removed from the current history entry before exchange", async () => {
  const order: string[] = [];
  const secret = consumeControlPlaneEntry({ href: "http://127.0.0.1:5188/?lang=zh#control-plane=test-once&tab=settings" }, {
    state: { keep: true }, replaceState(state, _, url) { assert.deepEqual(state, { keep: true }); order.push(String(url)); },
  });
  const session = new ControlPlaneSession(async (url, init) => {
    assert.equal(order[0], "/?lang=zh#tab=settings");
    assert.equal(url, "/__agentcanvas/pi/auth/exchange");
    assert.deepEqual(JSON.parse(String(init?.body)), { secret: "test-once" });
    assert.equal(init?.credentials, "same-origin");
    return Response.json(receipt());
  });
  await session.initialize(secret);
  assert.equal(session.getSnapshot().authenticated, true);
  assert.equal(session.getSnapshot().developerScope, false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes("test-csrf"), false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes("test-once"), false);
});

test("requests wait for startup exchange and attach cookie and write CSRF without replay", async () => {
  let finish!: (response: Response) => void;
  const calls: { url: string; init?: RequestInit }[] = [];
  const session = new ControlPlaneSession(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Promise<Response>(resolve => { finish = resolve; });
    return Response.json({ ok: true });
  });
  const startup = session.initialize("test-entry");
  const write = session.request("/__agentcanvas/pi/config", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  finish(Response.json(receipt()));
  await Promise.all([startup, write]);
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[1].init?.headers).get(CONTROL_CSRF_HEADER), "test-csrf");
  assert.equal(new Headers(calls[1].init?.headers).get("content-type"), "application/json");
  assert.equal(calls[1].init?.credentials, "same-origin");
  await session.request("/__agentcanvas/pi/files/download?path=test");
  assert.equal(new Headers(calls[2].init?.headers).has(CONTROL_CSRF_HEADER), false);
});

test("anonymous initialization does not exchange or issue credentials and blocks later calls", async () => {
  const calls: string[] = [];
  const session = new ControlPlaneSession(async url => {
    calls.push(String(url));
    return Response.json({ code: "control_auth_required" }, { status: 401 });
  });
  await session.initialize();
  const result = await session.request("/__agentcanvas/pi/config", { method: "POST" });
  assert.equal(result.status, 401);
  assert.deepEqual(calls, ["/__agentcanvas/pi/auth/session"]);
});

test("expired authentication cancels active streams, prevents writes and never exchanges automatically", async () => {
  const calls: string[] = [];
  let streamSignal: AbortSignal | undefined;
  const session = new ControlPlaneSession(async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json(receipt());
    if (String(url).endsWith("/live")) { streamSignal = init?.signal ?? undefined; return new Response("event"); }
    return Response.json({ code: "control_session_expired" }, { status: 401 });
  });
  await session.initialize();
  await session.request("/__agentcanvas/pi/live");
  await session.request("/__agentcanvas/pi/config", { method: "POST" });
  assert.equal(streamSignal?.aborted, true);
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().code, "control_session_expired");
  const result = await session.request("/__agentcanvas/pi/config", { method: "POST" });
  assert.equal(result.status, 401);
  assert.equal(calls.length, 3);
});

test("developer scope requires an explicit action and revoke removes it; logout does not log back in", async () => {
  const calls: string[] = [];
  const session = new ControlPlaneSession(async (url, init) => {
    calls.push(String(url));
    if (calls.length > 1) assert.equal(new Headers(init?.headers).get(CONTROL_CSRF_HEADER), "test-csrf");
    return Response.json(String(url).endsWith("/logout") ? { ok: true } : receipt(String(url).endsWith("/grant")));
  });
  await session.initialize();
  assert.equal(session.getSnapshot().developerScope, false);
  await session.changeDeveloperScope(true);
  assert.equal(session.getSnapshot().developerScope, true);
  await session.changeDeveloperScope(false);
  assert.equal(session.getSnapshot().developerScope, false);
  await session.logout();
  assert.equal(session.getSnapshot().authenticated, false);
  await session.request("/__agentcanvas/pi/learning");
  assert.deepEqual(calls.map(url => url.split("/auth")[1]), ["/session", "/developer/grant", "/developer/revoke", "/logout"]);
});

test("uncertain writes are delivered once and no automatic authentication recovery occurs", async () => {
  let calls = 0;
  const session = new ControlPlaneSession(async () => {
    if (++calls === 1) return Response.json(receipt());
    throw new TypeError("receipt lost");
  });
  await session.initialize();
  await assert.rejects(session.request("/__agentcanvas/pi/config", { method: "POST" }), /receipt lost/);
  assert.equal(calls, 2);
});

test("developer rejection keeps user access while CSRF rejection requires fresh authorization", async () => {
  let calls = 0;
  const session = new ControlPlaneSession(async () => {
    calls++;
    if (calls === 1) return Response.json(receipt(true));
    return Response.json({ code: calls === 2 ? "control_developer_required" : "control_csrf_invalid" }, { status: 403 });
  });
  await session.initialize();
  await session.request("/__agentcanvas/pi/learning");
  assert.equal(session.getSnapshot().authenticated, true);
  assert.equal(session.getSnapshot().developerScope, false);
  await session.request("/__agentcanvas/pi/config", { method: "POST" });
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().code, "control_csrf_invalid");
  await session.request("/__agentcanvas/pi/config", { method: "POST" });
  assert.equal(calls, 3);
});

test("trusted cloud exchange is explicit after an anonymous page load", async () => {
  const calls: string[] = [];
  const session = new ControlPlaneSession(async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json({ code: "control_auth_required" }, { status: 401 });
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    return Response.json(receipt());
  });
  await session.initialize();
  assert.equal(calls.length, 1);
  await session.authorizeTrustedEntry();
  assert.equal(session.getSnapshot().authenticated, true);
  assert.deepEqual(calls, ["/__agentcanvas/pi/auth/session", "/__agentcanvas/pi/auth/exchange"]);
});

test("a delayed developer grant cannot restore scope after revoke or logout", async () => {
  for (const revoke of [true, false]) {
    let finishGrant!: (response: Response) => void;
    let streamSignal: AbortSignal | null | undefined;
    const session = new ControlPlaneSession(async (url, init) => {
      if (String(url).endsWith("/grant")) return new Promise<Response>(resolve => { finishGrant = resolve; });
      if (String(url).endsWith("/logout")) return Response.json({ authenticated: false });
      if (String(url).endsWith("/revoke")) return Response.json(receipt(false));
      if (String(url).endsWith("/live")) { streamSignal = init?.signal; return new Response("event"); }
      return Response.json(receipt(true));
    });
    await session.initialize();
    await session.request("/__agentcanvas/pi/live");
    const epoch = session.getSnapshot().epoch;
    const grant = session.changeDeveloperScope(true);
    await Promise.resolve();
    if (revoke) await session.changeDeveloperScope(false); else await session.logout();
    assert.equal(session.getSnapshot().developerScope, false);
    assert.ok(session.getSnapshot().epoch > epoch, "scope revocation clears the entire app's cached evidence");
    assert.equal(streamSignal?.aborted, true);
    finishGrant(Response.json(receipt(true)));
    await grant;
    assert.equal(session.getSnapshot().developerScope, false);
    assert.equal(session.getSnapshot().authenticated, revoke);
  }
});

test("a delayed exchange cannot restore authentication after logout", async () => {
  let finishExchange!: (response: Response) => void;
  const session = new ControlPlaneSession(async url => {
    if (String(url).endsWith("/exchange")) return new Promise<Response>(resolve => { finishExchange = resolve; });
    return Response.json(String(url).endsWith("/logout") ? { authenticated: false } : receipt());
  });
  await session.initialize();
  const exchange = session.authorizeTrustedEntry();
  await Promise.resolve();
  await session.logout();
  finishExchange(Response.json(receipt()));
  await exchange;
  assert.equal(session.getSnapshot().authenticated, false);
});
