import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLOUD_CONTROL_CONTEXT, createControlPlaneAuth } from "./controlPlaneAuth.ts";
import { createPiHttpHost } from "./piHost.ts";

async function fixture(options: { ttl?: number; entryTtl?: number; cloud?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rtb-control-auth-")), dataDir = join(root, "data");
  let clock = Date.now(), cloud = options.cloud ? { principal: "cloud-owner", publicOrigin: "https://preview.example" } : undefined;
  const auth = createControlPlaneAuth({ dataDir, now: () => clock, sessionTtlMs: options.ttl, entryTtlMs: options.entryTtl });
  const host = createPiHttpHost({ cwd: root, dataDir, controlPlaneAuth: auth, browser: false, routineClock: false,
    bridgeFactory: async () => { throw new Error("Authentication checks must not invoke an engine"); } });
  const server = createServer((req, res) => {
    if (cloud) (req as IncomingMessage & { [CLOUD_CONTROL_CONTEXT]: typeof cloud })[CLOUD_CONTROL_CONTEXT] = cloud;
    void host.handle(req, res).catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, base = `${origin}/__agentcanvas/pi`;
  const fetchApi = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const login = async () => {
    const secret = options.cloud ? undefined : auth.issueEntry(origin);
    const response = await fetchApi("/auth/exchange", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ secret }) });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.get("set-cookie")!.split(";")[0], session = await response.json();
    const headers = { cookie, origin, "content-type": "application/json", "x-raytonebot-csrf": session.csrfToken };
    return { secret, response, session, headers, request: (path: string, init: RequestInit = {}) => fetchApi(path, { ...init, headers: { ...headers, ...init.headers } }) };
  };
  return { root, dataDir, host, auth, origin, base, server, fetchApi, login, advance(ms: number) { clock += ms; }, setCloud(value: typeof cloud) { cloud = value; }, async close() { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); rmSync(auth.root, { recursive: true, force: true }); } };
}

test("control plane is private by default; public health and preflight disclose no credentials", async () => {
  const f = await fixture();
  try {
    for (const path of ["/state", "/bots", "/providers", "/learning", "/files", "/conversations", "/routines", "/auth/session"]) {
      const response = await f.fetchApi(path); assert.equal(response.status, 401, path); assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.deepEqual(await (await f.fetchApi("/health")).json(), { status: "ok" });
    const preflight = await f.fetchApi("/learning", { method: "OPTIONS" }); assert.equal(preflight.status, 204); assert.equal(await preflight.text(), "");
    for (const body of [{}, { secret: "wrong", requestedBy: "user_session", authorizedVia: "forged" }]) {
      const response = await f.fetchApi("/auth/exchange", { method: "POST", body: JSON.stringify(body) }); assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.equal((await f.fetchApi("/learning", { method: "POST", headers: { origin: f.origin, authorization: "Bearer model-lease", "x-raytone-control-identity": "owner" }, body: "{}" })).status, 401);
    assert.equal((await f.fetchApi("/auth/exchange", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
  } finally { await f.close(); }
});

test("local one-time exchange, CSRF, developer grant/revoke, logout and expiry preserve boundaries", async () => {
  const f = await fixture({ ttl: 60000, entryTtl: 1000 });
  try {
    const expiredEntry = f.auth.issueEntry(f.origin); f.advance(1001);
    assert.equal((await f.fetchApi("/auth/exchange", { method: "POST", body: JSON.stringify({ secret: expiredEntry }) })).status, 401);
    const user = await f.login();
    assert.match(user.response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/); assert.doesNotMatch(user.response.headers.get("set-cookie")!, /Secure/);
    assert.equal(user.session.developerScope, false);
    assert.equal((await f.fetchApi("/auth/exchange", { method: "POST", body: JSON.stringify({ secret: user.secret }) })).status, 401);
    assert.equal((await user.request("/learning")).status, 403);
    assert.equal((await user.request("/auth/developer/grant", { method: "POST", headers: { "x-raytonebot-csrf": "wrong" } })).status, 403);
    assert.equal((await user.request("/auth/developer/grant", { method: "POST" })).status, 200);
    const save = await user.request("/learning", { method: "POST", body: JSON.stringify({ action: "settings", revision: 0, enabled: false, reuse: false, dailyLimit: 2, requestedBy: "background", authorizedVia: "forged" }) });
    assert.equal(save.status, 200); const state = await save.json();
    assert.equal(state.lastAuthorization.requestedBy, "user_session"); assert.notEqual(state.lastAuthorization.authorizedVia, "forged"); assert.equal(state.lastAuthorization.scope, "developer");
    assert.equal((await user.request("/auth/developer/revoke", { method: "POST" })).status, 200); assert.equal((await user.request("/learning")).status, 403);
    assert.equal((await user.request("/bots")).status, 200);
    assert.equal((await user.request("/auth/logout", { method: "POST" })).status, 200); assert.equal((await user.request("/auth/session")).status, 401);
    const next = await f.login(); f.advance(60001); const response = await next.request("/bots"); assert.equal(response.status, 401); assert.equal((await response.json()).code, "control_session_expired");
    const log = readFileSync(join(f.auth.root, "authorization.jsonl"), "utf8");
    for (const value of [user.secret!, user.session.csrfToken, user.headers.cookie, next.session.csrfToken]) assert.ok(!log.includes(value));
    assert.match(log, /authorization_accepted/); assert.match(log, /authorization_rejected/);
  } finally { await f.close(); }
});

test("authorization audit failure blocks mutations; RSL provenance is committed atomically with state", async () => {
  const f = await fixture();
  try {
    const user = await f.login(); await user.request("/auth/developer/grant", { method: "POST" });
    const auditFile = join(f.auth.root, "authorization.jsonl"); rmSync(auditFile); mkdirSync(auditFile);
    assert.equal((await user.request("/learning", { method: "POST", body: JSON.stringify({ action: "settings", revision: 0, enabled: true, reuse: true, dailyLimit: 2 }) })).status, 503);
    assert.equal(f.host.controller.learning.state().revision, 0); assert.equal(f.host.controller.learning.state().enabled, false);
    rmSync(auditFile, { recursive: true });
    mkdirSync(join(f.dataDir, "learning/state.json"), { recursive: true });
    assert.equal((await user.request("/learning", { method: "POST", body: JSON.stringify({ action: "settings", revision: 0, enabled: true, reuse: true, dailyLimit: 2 }) })).status, 503);
    assert.equal(f.host.controller.learning.state().revision, 0); assert.equal(f.host.controller.learning.state().lastAuthorization, undefined);
  } finally { await f.close(); }
});

test("cloud identity stays in trusted request context; sessions require it on every request", async () => {
  const f = await fixture({ cloud: true });
  try {
    assert.equal((await f.fetchApi("/routines")).status, 200);
    assert.equal((await f.fetchApi("/bots")).status, 401);
    const user = await f.login(); assert.match(user.response.headers.get("set-cookie")!, /; Secure/);
    assert.equal((await user.request("/bots")).status, 200);
    f.setCloud({ principal: "different-owner", publicOrigin: "https://preview.example" }); assert.equal((await user.request("/bots")).status, 401);
    f.setCloud(undefined);
    assert.equal((await user.request("/bots", { headers: { "x-raytone-control-identity": "cloud-owner" } })).status, 401);
    assert.equal((await f.fetchApi("/routines", { headers: { "x-raytone-control-identity": "cloud-owner" } })).status, 401);
    assert.equal((await f.fetchApi("/auth/exchange", { method: "POST", body: "{}", headers: { "x-raytone-control-identity": "cloud-owner" } })).status, 401);
  } finally { await f.close(); }
});

test("slow JSON and upload bodies cannot commit after their session is revoked", async () => {
  const f = await fixture();
  try {
    for (const [upload, revoke] of [[false, "logout"], [false, "developer/revoke"], [false, "expiry"], [true, "logout"], [true, "expiry"]] as const) {
      const user = await f.login(); await user.request("/auth/developer/grant", { method: "POST" });
      const body = upload ? "upload bytes" : JSON.stringify({ action: "settings", revision: 0, enabled: true, reuse: true, dailyLimit: 2 });
      const response = new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${f.base}${upload ? "/files?scope=assistant&name=demo.txt" : "/learning"}`, { method: "POST", headers: { ...user.headers, "content-length": Buffer.byteLength(body) } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
        req.on("error", reject); req.write(body.slice(0, 1));
        setTimeout(() => {
          if (revoke === "expiry") { f.advance(30 * 60_000 + 1); req.end(body.slice(1)); }
          else void user.request(`/auth/${revoke}`, { method: "POST" }).then(() => req.end(body.slice(1))).catch(reject);
        }, 30);
      });
      // Revocation ends an already-open response; the body may then finish, but cannot commit.
      assert.equal(await response, revoke === "developer/revoke" ? 403 : 401);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(f.host.controller.learning.state().revision, 0);
      assert.ok(!readdirSync(f.root).includes("uploads"));
    }
  } finally { await f.close(); }
});
