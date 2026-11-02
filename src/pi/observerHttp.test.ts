import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManifest } from "../../scripts/observer-manifest.mjs";
import { createControlPlaneAuth, CLOUD_CONTROL_CONTEXT } from "./controlPlaneAuth.ts";
import { createConversationStore } from "./conversationStore.ts";
import { createPiHttpHost } from "./piHost.ts";
import { createRepoSnapshot } from "./observer/version.ts";
import type { FindingProposal } from "./observer/types.ts";

async function fixture(options: { sessionTtlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rtb-observer-http-")), appRoot = join(root, "app"), dataDir = join(root, "data");
  mkdirSync(join(appRoot, "src"), { recursive: true }); writeFileSync(join(appRoot, "src/demo.ts"), "export const value = 'PRIVATE_QUERY_RAW';\n");
  const manifestPath = join(appRoot, "OBSERVER-BUILD.json"); writeFileSync(manifestPath, JSON.stringify(createManifest(appRoot, ["src/demo.ts"])));
  const seed = createConversationStore(dataDir); seed.begin("ordinary", "assistant", "Synthetic ordinary chat"); seed.append("ordinary", { id: "normal-end", type: "run.finished", runId: "normal-run", seq: 1, ts: Date.now(), payload: { status: "success" } }); seed.flush("ordinary");
  let calls = 0, hold = false, entered = false, releaseRepo: (() => void) | undefined, blockRepo = false, repoEntered = false, trustedCloud = false;
  const auth = createControlPlaneAuth({ dataDir, sessionTtlMs: options.sessionTtlMs });
  const host = createPiHttpHost({ cwd: appRoot, appRoot, dataDir, controlPlaneAuth: auth, browser: false, routineClock: false,
    bridgeFactory: async () => ({ subscribe: () => () => {}, async prompt() {}, async abort() {}, dispose() {}, async configure() {}, async newSession() {}, async state() { return { models: [], tools: [] }; } }),
    observerRuntime: { repo: async () => { if (blockRepo) { repoEntered = true; await new Promise<void>(resolve => { releaseRepo = resolve; }); } return createRepoSnapshot({ root: appRoot, manifestPath }); },
      diagnose: async input => {
        calls++; input.chargeRequest(); const result = await input.execute({ type: "repo_read", path: "src/demo.ts", lines: 1 }, input.signal); entered = true;
        if (hold) await new Promise<void>((resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        const proposal: FindingProposal = { kind: "project_suggestion", title: "Add a focused test", inference: "The observed export has no test evidence in this query.", factIds: result.facts.map(fact => fact.id), proposedAction: { kind: "add_test", target: { kind: "code", id: "src/demo.ts" }, description: "Check the exported result with a focused test.", verificationRefs: result.evidenceRefs.map(ref => ref.id) } };
        return { report: "A focused test can verify the exported result.", proposals: [proposal] };
      }, explain: async input => { calls++; input.chargeRequest(); input.onUsage({ inputTokens: 1, outputTokens: 1 }); return { report: "The host facts are unverified business outcomes.", proposals: [] }; } } });
  await host.controller.configure({ provider: "fixture", model: "fixture-model", providerDefinition: { id: "fixture", name: "Fixture", protocol: "openai-compatible", authMode: "none", baseUrl: "https://fixture.invalid/v1", models: ["fixture-model"] } });
  const server = createServer((req, res) => { if (trustedCloud) (req as IncomingMessage & { [CLOUD_CONTROL_CONTEXT]: { principal: string; publicOrigin: string } })[CLOUD_CONTROL_CONTEXT] = { principal: "cloud-owner", publicOrigin: "https://preview.example" }; void host.handle(req, res).catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, base = `${origin}/__agentcanvas/pi`;
  const login = async (developer = false) => {
    const exchange = await fetch(`${base}/auth/exchange`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(trustedCloud ? {} : { secret: auth.issueEntry(origin) }) }); assert.equal(exchange.status, 200);
    const state = await exchange.json(), headers = { origin, cookie: exchange.headers.get("set-cookie")!.split(";")[0], "x-raytonebot-csrf": state.csrfToken, "content-type": "application/json" };
    const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (developer) assert.equal((await request("/auth/developer/grant", {})).status, 200);
    return { request };
  };
  const enable = async (user: Awaited<ReturnType<typeof login>>) => { const view = await (await user.request("/observer")).json(); const response = await user.request("/observer", { action: "settings", revision: view.revision, enabled: true, backgroundEnabled: false, windowDays: 7, model: { provider: "fixture", model: "fixture-model" }, budgets: view.budgets }); assert.equal(response.status, 200, await response.clone().text()); };
  return { root, appRoot, dataDir, host, auth, server, origin, base, login, enable, get calls() { return calls; }, get entered() { return entered; }, get repoEntered() { return repoEntered; }, set hold(value: boolean) { hold = value; }, set blockRepo(value: boolean) { blockRepo = value; repoEntered = false; }, releaseRepo() { blockRepo = false; releaseRepo?.(); }, set trustedCloud(value: boolean) { trustedCloud = value; }, async close() { blockRepo = false; releaseRepo?.(); await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) { for (let index = 0; index < 200 && !check(); index++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); }

test("Observer HTTP has a reserved host identity, developer-only history/evidence, durable reports and independent ordinary history", async () => {
  const f = await fixture();
  try {
    const ordinary = await f.login(), developer = await f.login(true); await f.enable(developer);
    assert.equal((await ordinary.request("/observer")).status, 403);
    const response = await developer.request("/prompt", { botId: "system:observer", conversationId: "observer:private", prompt: "Inspect the export", requestId: "client-request" });
    assert.equal(response.status, 200, await response.clone().text()); const events = (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); assert.ok(events.some(event => event.type === "artifact.created")); assert.equal(f.calls, 1);
    const publicList = await (await ordinary.request("/conversations?query=focused")).json(); assert.ok(!publicList.conversations.some((item: any) => item.id.startsWith("observer:")));
    const privateList = await (await developer.request("/conversations")).json(); assert.ok(privateList.conversations.some((item: any) => item.systemRole === "observer"));
    const history = await (await developer.request("/conversations/observer:private")).json(); assert.equal(history.systemRole, "observer"); assert.equal(history.eventCount, history.events.length); assert.deepEqual(history.acceptedRequestIds, ["client-request"]); assert.ok(history.events.some((event: any) => event.type === "artifact.created"));
    assert.equal((await ordinary.request("/conversations/observer:private")).status, 403);
    assert.equal((await ordinary.request("/artifacts?conversationId=observer:private")).status, 403);
    assert.equal((await ordinary.request("/state?conversationId=observer:private")).status, 403);
    const view = await (await developer.request("/observer")).json(), finding = view.findings[0];
    assert.equal((await developer.request("/observer/evidence?" + new URLSearchParams({ findingId: finding.id, revision: String(finding.revision), evidenceId: finding.evidenceRefs[0].id }))).status, 200);
    assert.equal((await developer.request("/observer", { action: "review", id: finding.id, revision: finding.revision, status: "accepted" })).status, 200);
    const accepted = f.host.observer.store.get(finding.id)!;
    const shared = await (await developer.request("/observer", { action: "handoff", id: accepted.id, revision: accepted.revision, botId: "assistant", scope: "Inspect the suggested test" })).json(); assert.ok(shared.handoff.token); assert.ok(!shared.draft.includes(shared.handoff.token));
    const retry = await developer.request("/prompt", { botId: "system:observer", conversationId: "observer:private", prompt: "Inspect the export", requestId: "client-request" }); await retry.text(); assert.equal(f.calls, 1);
    assert.doesNotMatch(readFileSync(join(f.dataDir, "observer/state.json"), "utf8"), /PRIVATE_QUERY_RAW/);
    writeFileSync(join(f.appRoot, "src/demo.ts"), "changed bytes");
    const ordinaryAfterObserverFailure = await developer.request("/conversations"); assert.equal(ordinaryAfterObserverFailure.status, 200); assert.ok((await ordinaryAfterObserverFailure.json()).conversations.some((item: any) => item.id === "ordinary"));
  } finally { await f.close(); }
});

test("a revoked developer request cannot cross asynchronous repository preparation, and scope regrant does not revive its proof", async () => {
  const f = await fixture();
  try {
    const developer = await f.login(true); await f.enable(developer);
    f.blockRepo = true;
    const pending = developer.request("/prompt", { botId: "system:observer", conversationId: "observer:race", prompt: "Inspect", requestId: "race" });
    await until(() => f.repoEntered);
    assert.equal((await developer.request("/auth/developer/revoke", {})).status, 200);
    assert.equal((await developer.request("/auth/developer/grant", {})).status, 200);
    f.releaseRepo(); const response = await pending; assert.ok([401, 403].includes(response.status)); assert.equal(f.calls, 0); assert.equal(f.host.observer.store.runs().length, 0);
    f.blockRepo = true;
    const view = f.host.observer.store.settings();
    const mutation = developer.request("/observer", { action: "settings", revision: view.revision, enabled: true, backgroundEnabled: false, windowDays: 7, model: { provider: "fixture", model: "fixture-model" }, budgets: { ...view.budget, dailyRequests: view.budget.dailyRequests + 1 } });
    await until(() => f.repoEntered); await developer.request("/auth/developer/revoke", {}); f.releaseRepo(); assert.equal((await mutation).status, 403); assert.equal(f.host.observer.store.settings().enabled, true); assert.equal(f.host.observer.store.settings().budget.dailyRequests, view.budget.dailyRequests);
  } finally { await f.close(); }
});

test("session expiry cancels an accepted manual Observer run, and trusted but unverified cloud ingress cannot open L2", async () => {
  const f = await fixture({ sessionTtlMs: 500 });
  try {
    const developer = await f.login(true); await f.enable(developer); f.hold = true;
    const request = developer.request("/prompt", { botId: "system:observer", conversationId: "observer:expiry", prompt: "Inspect", requestId: "expiry" });
    await until(() => f.entered); await until(() => f.host.observer.store.runs()[0]?.status === "cancelled"); await (await request).text(); assert.equal(f.calls, 1);
    f.trustedCloud = true; const cloud = await f.login(true);
    const response = await cloud.request("/prompt", { botId: "system:observer", conversationId: "observer:cloud", prompt: "Inspect", requestId: "cloud" }); assert.equal(response.status, 403); assert.equal((await response.json()).code, "observer_l2_platform_unverified"); assert.equal(f.calls, 1);
  } finally { await f.close(); }
});
