import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManifest } from "../../scripts/observer-manifest.mjs";
import { createPiHttpHost } from "./piHost.ts";
import { createObserverService } from "./observer/service.ts";
import { createObserverStore } from "./observer/store.ts";
import { createRepoSnapshot } from "./observer/version.ts";
import { effectInput, implementationInput, resolveFollowUpReferences, validFollowUp } from "./observer/followUp.ts";
import type { FollowUpReferenceInput, FollowUpSource, ImplementationInput, EffectInput } from "./observer/types.ts";
const actor = { requestedBy: "user_session", scope: "developer", authorizedVia: "session-fixture", version: 1, at: Date.now() } as const;
const ref = (source: FollowUpSource): FollowUpReferenceInput => ({ kind: "conversation_run", source: source.source, version: source.version, runId: source.runId });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rtb-observer-follow-up-")), appRoot = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(join(appRoot, "src"), { recursive: true }); writeFileSync(join(appRoot, "src/demo.ts"), "export const example = 1;\n");
  const manifestPath = join(appRoot, "OBSERVER-BUILD.json"); writeFileSync(manifestPath, JSON.stringify(createManifest(appRoot, ["src/demo.ts"])));
  let modelCalls = 0;
  const host = createPiHttpHost({ cwd: appRoot, appRoot, dataDir, vaultDir: join(root, "vault"), browser: false, routineClock: false,
    bridgeFactory: async () => ({ subscribe: () => () => {}, async prompt() {}, async abort() {}, dispose() {}, async configure() {}, async newSession() {}, async state() { return { models: [], tools: [] }; } }),
    observerRuntime: { repo: () => createRepoSnapshot({ root: appRoot, manifestPath }), diagnose: async input => { modelCalls++; input.chargeRequest(); const query = await input.execute({ type: "repo_read", path: "src/demo.ts", lines: 1 }, input.signal); return { report: "An isolated test can verify the exported value.", proposals: [{ kind: "project_suggestion", title: "Verify the export", inference: "The observed code can be verified independently.", factIds: query.facts.map(fact => fact.id), proposedAction: { kind: "add_test", target: { kind: "code", id: "src/demo.ts" }, description: "Add a focused test for the value.", verificationRefs: query.evidenceRefs.map(item => item.id) } }] }; } } });
  await host.controller.configure({ provider: "fixture", model: "fixture-model", providerDefinition: { id: "fixture", name: "Fixture", protocol: "openai-compatible", authMode: "none", baseUrl: "https://fixture.invalid/v1", models: ["fixture-model"] } });
  await host.controller.runPrompt({ conversationId: "independent-source", requestId: "independent-run", prompt: "A public source for the original finding" }, () => {});
  const store = host.observer.store;
  const config = host.controller.observerModels().find(item => item.provider === "fixture")!;
  store.updateSettings(0, { enabled: true, model: { provider: config.provider, model: config.model, configRevision: config.configRevision } }, actor.authorizedVia);
  await host.observer.run({ question: "Inspect the export", conversationId: "observer:diagnosis", clientRequestId: "finding-request", authorization: actor, onEvent() {} });
  const pending = store.list()[0]; store.review({ id: pending.id, revision: pending.revision, status: "accepted" }, actor.authorizedVia);
  // New result sources are deliberately absent from the original finding's independent scope.
  for (const id of ["baseline", "candidate"]) { await host.controller.runPrompt({ conversationId: id, requestId: `${id}-run`, prompt: `${id} body contains PUBLIC_BODY_MARKER that must not be returned in the source catalog.` }, () => {}); host.controller.renameConversation(id, `${id} public title`); }
  const sources = await host.observer.followUpSources(), baseline = sources.sources.find(source => source.runId === "baseline-run")!, candidate = sources.sources.find(source => source.runId === "candidate-run")!;
  const implementation: ImplementationInput = { status: "implemented", summary: "IMPLEMENTATION_BODY verified by the user's check.", references: [ref(candidate)] };
  const effect: EffectInput = { judgment: "improved", summary: "EFFECT_BODY is a user judgment only.", baseline: [ref(baseline)], candidate: [ref(candidate)], successCriteria: "USER_CRITERIA: the same public check finishes with fewer retries.", sampleSize: 2, costNotes: "USER_COST: approximate manual notes; provider billing was not verified." };
  let server: ReturnType<typeof createServer> | undefined;
  const listen = async () => { server = createServer((req, res) => { void host.handle(req, res).catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end(); } }); }); await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
  return { root, appRoot, dataDir, manifestPath, host, store, baseline, candidate, implementation, effect, listen, get finding() { return store.list()[0]; }, get modelCalls() { return modelCalls; }, async close() { await host.dispose(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

test("follow-up records preserve approval and finding revision, survive reload, and clearly remain user claims", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.finding);
    assert.deepEqual(original.scope.map(source => source.conversationId), ["independent-source"]);
    const first = await f.host.observer.update({ action: "record_implementation", id: original.id, revision: original.revision, followUpRevision: 0, implementation: f.implementation }, actor);
    assert.ok("followUp" in first); assert.equal(first.followUp!.revision, 1);
    const second = await f.host.observer.update({ action: "record_effect", id: original.id, revision: original.revision, followUpRevision: 1, effect: f.effect }, actor);
    assert.ok("followUp" in second); assert.equal(second.followUp!.revision, 2); assert.equal(f.finding.revision, original.revision); assert.deepEqual(f.finding.approvedAction, original.approvedAction); assert.equal(f.finding.reviewStatus, "accepted"); assert.equal(f.finding.validity, "current");
    assert.equal(f.finding.followUp!.effect!.verification, "user_recorded"); assert.equal(f.finding.followUp!.effect!.authorizedVia, actor.authorizedVia); assert.equal(f.finding.followUp!.effect!.findingRevision, original.revision); assert.equal(f.finding.followUp!.effect!.baseline[0].contextFreshness, "unknown"); assert.equal(f.finding.followUp!.effect!.baseline[0].model, undefined);
    assert.equal(f.modelCalls, 1, "recording may not trigger another model request");
    const reopened = createObserverStore({ dataDir: f.dataDir }); try { assert.deepEqual(reopened.get(original.id)?.followUp, f.finding.followUp); } finally { reopened.dispose(); }
    const history = await f.host.observer.conversation("observer:diagnosis"); assert.doesNotMatch(JSON.stringify(history.events), /IMPLEMENTATION_BODY|EFFECT_BODY/);
    assert.doesNotMatch(JSON.stringify(await f.host.observer.followUpSources()), /PUBLIC_BODY_MARKER|sourceGeneration|prompt/);
  } finally { await f.close(); }
});

test("stale findings accept historical records without reapproval; independent revisions and strict input validation fail closed", async () => {
  const f = await fixture();
  try {
    const finding = f.finding; f.store.setFindingValidity(finding.id, "stale");
    const [one, two] = await Promise.allSettled([
      f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation }, actor),
      f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: { ...f.implementation, summary: "Concurrent edit" } }, actor),
    ]);
    assert.equal([one, two].filter(result => result.status === "fulfilled").length, 1); assert.match(String([one, two].find(result => result.status === "rejected")!.reason), /observer_follow_up_conflict/);
    assert.equal(f.finding.validity, "stale"); assert.equal(f.finding.reviewStatus, "accepted"); assert.equal(f.finding.revision, finding.revision);
    await assert.rejects(f.host.observer.update({ action: "record_effect", id: finding.id, revision: finding.revision - 1, followUpRevision: 1, effect: f.effect }, actor), /observer_revision_conflict/);
    const bytes = readFileSync(join(f.dataDir, "observer/state.json"), "utf8");
    for (const value of [
      { ...f.implementation, references: [] }, { ...f.implementation, summary: "x".repeat(2001) }, { ...f.implementation, references: Array(9).fill(f.implementation.references[0]) }, { ...f.implementation, authorizedVia: "forged" }, { ...f.implementation, references: [{ ...f.implementation.references[0], harness: "pi" }] },
    ]) assert.throws(() => implementationInput(value));
    for (const value of [
      { ...f.effect, candidate: f.effect.baseline }, { ...f.effect, successCriteria: "" }, { ...f.effect, baseline: [] }, { ...f.effect, sampleSize: 0 }, { ...f.effect, sampleSize: 1.5 }, { ...f.effect, sampleSize: Number.MAX_SAFE_INTEGER }, { ...f.effect, costNotes: "api_key: fixture-secret-123456" }, { ...f.effect, recordedAt: 123 }, { ...f.effect, costNotes: "x".repeat(1001) },
    ]) assert.throws(() => effectInput(value));
    assert.doesNotThrow(() => effectInput({ judgment: "inconclusive", summary: "No comparable evidence yet.", baseline: [], candidate: [] }));
    assert.equal(readFileSync(join(f.dataDir, "observer/state.json"), "utf8"), bytes);
    assert.equal(validFollowUp({ ...f.finding.followUp, effect: { ...f.effect, recordedAt: 1, requestedBy: "background" } }), false);
    const selected = f.candidate; f.host.controller.renameConversation("candidate", "A changed public title");
    await assert.rejects(f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 1, implementation: { ...f.implementation, references: [ref(selected)] } }, actor), /observer_follow_up_source_changed/);
  } finally { await f.close(); }
});

test("deleting linked result sources erases only dependent sections and prevents ID reuse from reviving old links", async () => {
  const f = await fixture();
  try {
    const finding = f.finding;
    await f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation }, actor);
    await f.host.observer.update({ action: "record_effect", id: finding.id, revision: finding.revision, followUpRevision: 1, effect: f.effect }, actor);
    f.host.controller.deleteConversation("baseline");
    assert.equal(f.finding.id, finding.id); assert.equal(f.finding.revision, finding.revision); assert.equal(f.finding.followUp!.revision, 3); assert.equal(f.finding.followUp!.effect, undefined); assert.ok(f.finding.followUp!.implementation); assert.deepEqual(f.finding.followUp!.clearedSections, ["effect"]);
    const afterBaseline = readFileSync(join(f.dataDir, "observer/state.json"), "utf8"); assert.doesNotMatch(afterBaseline, /EFFECT_BODY|USER_CRITERIA|USER_COST/); assert.match(afterBaseline, /IMPLEMENTATION_BODY/);
    f.host.controller.deleteConversation("candidate");
    assert.equal(f.finding.followUp!.revision, 4); assert.equal(f.finding.followUp!.implementation, undefined); assert.doesNotMatch(readFileSync(join(f.dataDir, "observer/state.json"), "utf8"), /IMPLEMENTATION_BODY|EFFECT_BODY/);
    await f.host.controller.runPrompt({ conversationId: "candidate", requestId: "candidate-new-run", prompt: "A new generation" }, () => {});
    await assert.rejects(f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 4, implementation: f.implementation }, actor), /observer_follow_up_source_changed/);
    const reopened = createObserverStore({ dataDir: f.dataDir }); try { assert.equal(reopened.get(finding.id)?.followUp?.revision, 4); assert.ok(reopened.get(finding.id)); } finally { reopened.dispose(); }
  } finally { await f.close(); }
});

test("follow-up writes are atomic on storage failure and legacy findings without followUp remain readable", async () => {
  const f = await fixture();
  try {
    const finding = f.finding, file = join(f.dataDir, "observer/state.json"), legacy = readFileSync(file, "utf8");
    const old = createObserverStore({ dataDir: f.dataDir }); try { assert.equal(old.get(finding.id)?.followUp, undefined); } finally { old.dispose(); }
    rmSync(file); mkdirSync(file);
    await assert.rejects(f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation }, actor), /observer_storage_unavailable/);
    rmSync(file, { recursive: true }); writeFileSync(file, legacy);
    const restored = createObserverStore({ dataDir: f.dataDir }); try { assert.equal(restored.get(finding.id)?.followUp, undefined); assert.equal(restored.get(finding.id)?.revision, finding.revision); } finally { restored.dispose(); }
  } finally { await f.close(); }
});

test("HTTP follow-up metadata and writes require developer sessions; forged operator fields and private sources are rejected", async () => {
  const f = await fixture();
  try {
    const origin = await f.listen(), base = `${origin}/__agentcanvas/pi`, login = async (developer: boolean) => {
      const exchange = await fetch(`${base}/auth/exchange`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ secret: f.host.controlPlaneAuth.issueEntry(origin) }) }); const session = await exchange.json();
      const headers = { origin, cookie: exchange.headers.get("set-cookie")!.split(";")[0], "x-raytonebot-csrf": session.csrfToken, "content-type": "application/json" };
      const request = (path: string, body?: unknown) => fetch(`${base}${path}`, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      if (developer) await request("/auth/developer/grant", {}); return request;
    };
    const user = await login(false), developer = await login(true), finding = f.finding, action = { action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation };
    assert.equal((await fetch(`${base}/observer/follow-up-sources`)).status, 401); assert.equal((await user("/observer/follow-up-sources")).status, 403); assert.equal((await user("/observer", action)).status, 403);
    const page = await (await developer("/observer/follow-up-sources?limit=1")).json(); assert.equal(page.sources.length, 1); assert.equal(page.nextCursor, 1);
    assert.ok(!JSON.stringify(page).includes("PUBLIC_BODY_MARKER"));
    assert.equal((await developer("/observer", { ...action, authorizedVia: "forged" })).status, 400);
    const wrong = structuredClone(action); wrong.implementation.references[0].source.conversationId = "observer:diagnosis";
    assert.equal((await developer("/observer", wrong)).status, 409);
    const save = await developer("/observer", action); assert.equal(save.status, 200); const body = await save.json(); assert.equal(body.followUp.revision, 1); assert.notEqual(body.followUp.implementation.authorizedVia, "forged");
    const saved = await (await developer(`/observer/findings/${finding.id}?revision=${finding.revision}`)).json(); assert.equal(saved.followUp.implementation.verification, "user_recorded");
    assert.equal(f.modelCalls, 1);
  } finally { await f.close(); }
});

test("revocation during asynchronous source preparation cancels pending follow-up writes without changing records", async () => {
  const f = await fixture(); let release!: (sources: FollowUpSource[]) => void, started = false;
  const sources = (await f.host.observer.followUpSources()).sources;
  const service = createObserverService({ store: f.store, appRoot: f.appRoot, models: () => [], resolveModel() { throw new Error("No model call allowed"); }, leaseModel: async () => { throw new Error("No model call allowed"); }, conversations: () => [], followUpSources: async () => { started = true; return await new Promise<FollowUpSource[]>(resolve => { release = resolve; }); }, submitLesson() {} });
  try {
    const finding = f.finding, pending = service.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation }, actor);
    assert.equal(started, true); service.revokeAuthorization(actor.authorizedVia); release(sources);
    await assert.rejects(pending, /observer_authorization_revoked/); assert.equal(f.finding.followUp, undefined); assert.equal(f.modelCalls, 1);
    assert.throws(() => resolveFollowUpReferences([{ ...ref(f.candidate), version: "0".repeat(64) }], sources), /observer_follow_up_source_changed/);
  } finally { await service.dispose(); await f.close(); }
});

test("existing handoff capabilities keep their approved payload and quota failures do not publish follow-up writes", async () => {
  const f = await fixture();
  try {
    const finding = f.finding;
    const shared = await f.host.observer.update({ action: "handoff", id: finding.id, revision: finding.revision, botId: "assistant", scope: "Inspect the approved code suggestion only." }, actor);
    assert.ok("handoff" in shared);
    const tools = await f.host.observer.handoffTools(shared.handoff!.token, "assistant", "ordinary-run", () => true);
    const before = await tools.run("observer_finding", {}); assert.equal(before.isError, false);
    await f.host.observer.update({ action: "record_implementation", id: finding.id, revision: finding.revision, followUpRevision: 0, implementation: f.implementation }, actor);
    const after = await tools.run("observer_finding", {}); assert.deepEqual(after, before); assert.doesNotMatch(after.text, /IMPLEMENTATION_BODY/);
    const file = join(f.dataDir, "observer/state.json"), saved = JSON.parse(readFileSync(file, "utf8")); saved.findings[0].inference = "x".repeat(10 * 1024 * 1024);
    writeFileSync(file, JSON.stringify(saved)); const bytes = readFileSync(file, "utf8"), reopened = createObserverStore({ dataDir: f.dataDir });
    try {
      assert.throws(() => reopened.recordFollowUp({ id: finding.id, revision: finding.revision, followUpRevision: 1, section: "effect", value: f.effect }, actor, refs => resolveFollowUpReferences(refs, [f.baseline, f.candidate])), /observer_report_full/);
      assert.equal(reopened.get(finding.id)?.followUp?.revision, 1); assert.equal(readFileSync(file, "utf8"), bytes);
    } finally { reopened.dispose(); }
  } finally { await f.close(); }
});

test("a delayed HTTP source-list response cannot expose metadata after developer access is revoked", async () => {
  const f = await fixture(); let release!: () => void, entered = false;
  try {
    const origin = await f.listen(), base = `${origin}/__agentcanvas/pi`;
    const exchange = await fetch(`${base}/auth/exchange`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ secret: f.host.controlPlaneAuth.issueEntry(origin) }) }); const session = await exchange.json();
    const headers = { origin, cookie: exchange.headers.get("set-cookie")!.split(";")[0], "x-raytonebot-csrf": session.csrfToken, "content-type": "application/json" };
    await fetch(`${base}/auth/developer/grant`, { method: "POST", headers });
    const original = f.host.observer.followUpSources.bind(f.host.observer);
    f.host.observer.followUpSources = async input => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return original(input); };
    const pending = fetch(`${base}/observer/follow-up-sources`, { headers });
    for (let index = 0; index < 100 && !entered; index++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(entered, true);
    await fetch(`${base}/auth/developer/revoke`, { method: "POST", headers }); release();
    const response = await pending; assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /baseline-run|candidate-run|public title/);
    assert.equal(f.finding.followUp, undefined);
  } finally { release?.(); await f.close(); }
});
