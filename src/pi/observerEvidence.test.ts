import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { allowedManifestPath, createManifest, trackedManifest, verifyManifest } from "../../scripts/observer-manifest.mjs";
import { publicProjection, safeText } from "./observer/evidence.ts";
import { createObserverQueries } from "./observer/queries.ts";
import { createObserverStore } from "./observer/store.ts";
import { createRepoSnapshot, verifyRepoSnapshot } from "./observer/version.ts";
import type { ConversationProjection, FindingProposal, ObserverBudget, RunSnapshot } from "./observer/types.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "rtb-observer-evidence-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(join(repoRoot, "src"), { recursive: true }); writeFileSync(join(repoRoot, "src/main.ts"), "export const answer = 42;\n// a public example\n");
  const manifestPath = join(repoRoot, "OBSERVER-BUILD.json");
  writeFileSync(manifestPath, JSON.stringify(createManifest(repoRoot, ["src/main.ts"], { buildId: "package-fixture" })));
  const repo = createRepoSnapshot({ root: repoRoot, manifestPath });
  let clock = Date.parse("2026-11-02T12:00:00Z"); const now = () => clock;
  const store = createObserverStore({ dataDir, now });
  store.updateSettings(0, { enabled: true, model: { provider: "fixture", model: "selected-model", configRevision: "config-1" } }, "authorized-session");
  const source = store.registerSource("conversation", "persistent-conversation-generation-1");
  let conversations: ConversationProjection[] = [{ source, version: "untrusted-provider-version", botId: "assistant", harness: "pi", createdAt: clock - 1000, updatedAt: clock,
    events: [{ id: "user", type: "user", text: "Verify the CSV", at: clock - 1000 }, { id: "answer", type: "assistant", text: "The output is unverified.", at: clock }, { id: "terminal", type: "terminal", runId: "run-1", status: "error", at: clock }] }];
  const queries = createObserverQueries({ store, repo, now, conversations: () => conversations,
    config: () => ({ provider: "fixture", apiKey: "DO-NOT-EXPOSE", environment: { key: "hidden" }, models: ["selected-model"] }),
    logs: () => [{ at: clock, event: "tool.decision", decision: "refused", ...{ args: "HIDDEN-ARGS", reasoning: "HIDDEN-REASONING" } }],
    usage: () => ({ inputTokens: 42, outputTokens: null, known: false, cookie: "DO-NOT-EXPOSE" }) });
  t.after(() => { queries.dispose(); store.dispose(); });
  const reserve = (extra: Partial<Parameters<typeof store.reserveRun>[0]> = {}) => store.reserveRun({ level: "L2", requestedBy: "user_session", authorizedVia: "authorized-session", sourceScope: [source], repo, instructionVersion: "observer-v1", ...extra });
  const proposal = (run: RunSnapshot): FindingProposal => ({ kind: "project_suggestion", title: "Verify public code", inference: "A test can verify the exported answer.", factIds: run.facts.map(fact => fact.id), proposedAction: { kind: "add_test", target: { kind: "code", id: "src/main.ts" }, description: "Verify the exported value.", verificationRefs: run.evidenceRefs.map(ref => ref.id) } });
  return { root, repoRoot, manifestPath, dataDir, repo, store, queries, source, now, reserve, proposal, advance(ms: number) { clock += ms; }, get conversations() { return conversations; }, set conversations(value: ConversationProjection[]) { conversations = value; } };
}
async function finding(f: ReturnType<typeof fixture>) {
  const run = f.reserve(); const cap = f.queries.createCapability(run);
  await f.queries.execute(cap, { type: "repo_read", path: "src/main.ts" });
  const snapshot = f.store.getRun(run.id)!;
  await f.queries.beforePublication(snapshot, { factIds: snapshot.facts.map(fact => fact.id), evidenceIds: snapshot.evidenceRefs.map(ref => ref.id) });
  return f.store.commitReport(run.id, { report: "A supported code suggestion.", proposals: [f.proposal(snapshot)] })[0];
}

test("package manifests cover real bytes without Git; readable scope includes observer/learning/docs/scripts/vendor but not dist or secrets", t => {
  const f = fixture(t);
  for (const path of ["src/pi/observer/types.ts", "src/pi/learning/service.ts", "docs/notes.md", "scripts/check.mjs", "vendor/frozen.js", "dist/app.js"]) { mkdirSync(dirname(join(f.repoRoot, path)), { recursive: true }); writeFileSync(join(f.repoRoot, path), "public bytes"); assert.ok(allowedManifestPath(path), path); }
  const paths = ["src/main.ts", "src/pi/observer/types.ts", "src/pi/learning/service.ts", "docs/notes.md", "scripts/check.mjs", "vendor/frozen.js", "dist/app.js"];
  const manifest = createManifest(f.repoRoot, paths, { gitRevision: null, dirty: null, buildId: "no-git-package" });
  assert.equal(manifest.files.length, paths.length); assert.equal(manifest.gitRevision, null); verifyManifest(f.repoRoot, manifest);
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  const snapshot = createRepoSnapshot({ root: f.repoRoot, manifestPath: f.manifestPath });
  assert.ok(snapshot.buildStamp.files.some(file => file.path === "dist/app.js")); assert.ok(!snapshot.files.some(file => file.path.startsWith("dist/")));
  assert.throws(() => createManifest(f.repoRoot, [...paths, ".env"]), /observer_path_denied/);
  assert.throws(() => createManifest(f.repoRoot, [...paths, "OBSERVER-BUILD.json"]), /observer_path_denied/);
  symlinkSync(join(f.repoRoot, "src/main.ts"), join(f.repoRoot, "src/link.ts")); assert.throws(() => createManifest(f.repoRoot, ["src/link.ts"]), /observer_path_denied/);
  writeFileSync(join(f.repoRoot, "dist/app.js"), "different actual package bytes"); assert.throws(() => verifyRepoSnapshot(snapshot), /observer_source_changed/);
});

test("local tracked manifest excludes untracked private files and identifies dirty byte changes without changing HEAD", t => {
  const f = fixture(t); execFileSync("git", ["init", "-q"], { cwd: f.repoRoot }); execFileSync("git", ["add", "src/main.ts"], { cwd: f.repoRoot });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: f.repoRoot });
  writeFileSync(join(f.repoRoot, "untracked-private.txt"), "PRIVATE-DO-NOT-SCAN");
  const before = trackedManifest(f.repoRoot); assert.equal(before.dirty, false); assert.deepEqual(before.files.map(file => file.path), ["src/main.ts"]);
  writeFileSync(join(f.repoRoot, "src/main.ts"), "changed tracked code"); const after = trackedManifest(f.repoRoot);
  assert.equal(before.gitRevision, after.gitRevision); assert.equal(after.dirty, true); assert.notEqual(before.manifestHash, after.manifestHash);
});

test("capabilities cannot be forged; source generation and declared scope constrain private reads", async t => {
  const f = fixture(t), run = f.reserve(), cap = f.queries.createCapability(run);
  await assert.rejects(f.queries.execute({ id: cap.id }, { type: "sessions_list" }), /observer_capability_revoked/);
  const other = f.store.registerSource("other", "birth");
  await assert.rejects(f.queries.execute(cap, { type: "session_read", source: other }), /observer_scope_denied/);
  await assert.rejects(f.queries.execute(cap, { type: "repo_read", path: "../private" }), /observer_path_denied/);
  const result = await f.queries.execute(cap, { type: "sessions_list" }); assert.equal(result.facts[0].runId, run.id); assert.equal(result.facts[0].value.count, 1);
  f.queries.revokeRun(run.id); await assert.rejects(f.queries.execute(cap, { type: "sessions_list" }), /observer_capability_revoked/);
});

test("only public messages and lifecycle metadata reach queries; secrets and raw tool/native reasoning never enter persistent evidence", async t => {
  const f = fixture(t); f.conversations[0].events.push({ id: "tool", type: "tool", text: "HIDDEN-TOOL-RESULT", tool: "read", status: "success", ...{ args: "HIDDEN-ARGS" } });
  f.conversations[0].events.push({ id: "hidden", type: "reasoning" as never, text: "HIDDEN-REASONING" });
  const run = f.reserve(), cap = f.queries.createCapability(run);
  const read = await f.queries.execute(cap, { type: "session_read", source: f.source });
  assert.match(read.content, /Verify the CSV/); assert.doesNotMatch(read.content, /HIDDEN/);
  const config = await f.queries.execute(cap, { type: "config" }); assert.doesNotMatch(config.content, /DO-NOT-EXPOSE|apiKey|environment/i);
  const logs = await f.queries.execute(cap, { type: "logs" }); assert.doesNotMatch(logs.content, /HIDDEN/);
  const usage = await f.queries.execute(cap, { type: "usage" }); assert.doesNotMatch(usage.content, /DO-NOT-EXPOSE|cookie/); assert.equal(JSON.parse(usage.content).inputTokens, 42);
  const state = readFileSync(join(f.store.root, "state.json"), "utf8"); assert.doesNotMatch(state, /Verify the CSV|HIDDEN|DO-NOT-EXPOSE/);
  assert.throws(() => safeText("password: clearly-private-value"), /observer_suspected_secret/);
});

test("host facts and typed actions cannot be replaced by model-authored facts or foreign fact IDs", async t => {
  const f = fixture(t), run = f.reserve(), cap = f.queries.createCapability(run);
  await f.queries.execute(cap, { type: "repo_read", path: "src/main.ts" }); const snapshot = f.store.getRun(run.id)!;
  const proposal = f.proposal(snapshot);
  assert.throws(() => f.store.commitReport(run.id, { report: "bad", proposals: [{ ...proposal, factIds: ["forged-fact"] }] }), /observer_fact_invalid/);
  assert.throws(() => f.store.commitReport(run.id, { report: "bad", proposals: [{ ...proposal, ...{ facts: [] } }] }), /observer_fact_invalid/);
  assert.throws(() => f.store.commitReport(run.id, { report: "bad", proposals: [{ ...proposal, proposedAction: { ...proposal.proposedAction, target: { kind: "code", id: "not-read.ts" } } }] }), /observer_action_invalid/);
  const saved = f.store.commitReport(run.id, { report: "No business success is inferred.", proposals: [proposal] })[0];
  assert.equal(saved.reviewStatus, "pending"); assert.equal(saved.validity, "current");
  const view = await f.queries.openEvidence(saved.id, saved.revision, saved.evidenceRefs[0].id); assert.equal(view.readOnly, true); assert.match(view.text, /answer = 42/);
  await assert.rejects(f.queries.openEvidence(saved.id, saved.revision + 1, saved.evidenceRefs[0].id), /observer_revision_conflict/);
});

test("tombstone is durable before revocation; deleting one source removes multi-source derived content and rejects late publication and ID reuse", async t => {
  const f = fixture(t), other = f.store.registerSource("other", "other-birth");
  const run = f.reserve({ sourceScope: [f.source, other], question: "DERIVED-PRIVATE-MARKER" }), cap = f.queries.createCapability(run);
  await f.queries.execute(cap, { type: "repo_read", path: "src/main.ts" });
  const saved = f.store.commitReport(run.id, { report: "DERIVED-PRIVATE-MARKER", proposals: [{ ...f.proposal(f.store.getRun(run.id)!), inference: "DERIVED-PRIVATE-MARKER" }] })[0];
  let revoked = false;
  f.store.subscribeSourceRevoked(() => { const disk = JSON.parse(readFileSync(join(f.store.root, "state.json"), "utf8")); assert.equal(disk.tombstones[0].cleanupPending, true); revoked = true; });
  f.store.beginSourceDeletion(f.source); assert.equal(revoked, true); assert.equal(f.store.get(saved.id), undefined);
  assert.doesNotMatch(readFileSync(join(f.store.root, "state.json"), "utf8"), /DERIVED-PRIVATE-MARKER/);
  await assert.rejects(f.queries.execute(cap, { type: "sessions_list" }), /observer_capability_revoked/);
  assert.throws(() => f.store.commitReport(run.id, { report: "DERIVED-PRIVATE-MARKER", proposals: [] }), /observer_run_revoked/);
  const next = f.store.registerSource("conversation", "persistent-conversation-generation-2"); assert.notEqual(next.generation, f.source.generation); assert.equal(f.store.sourceValid(f.source), false); assert.equal(f.store.sourceValid(next), true);
  const reopened = createObserverStore({ dataDir: f.dataDir, now: f.now }); assert.equal(reopened.sourceValid(f.source), false); assert.equal(reopened.get(saved.id), undefined); reopened.dispose();
});

test("failed derived cleanup keeps a persistent tombstone and fails closed; restart finishes cleanup before exposing reports", async t => {
  const f = fixture(t), saved = await finding(f), file = join(f.store.root, "state.json"), receipt = join(f.root, "tombstone-receipt.json");
  f.store.subscribeSourceRevoked(() => { renameSync(file, receipt); mkdirSync(file); });
  assert.throws(() => f.store.beginSourceDeletion(f.source), /observer_storage_unavailable/);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).tombstones[0].cleanupPending, true);
  assert.throws(() => f.store.get(saved.id), /observer_storage_unavailable/);
  rmSync(file, { recursive: true }); renameSync(receipt, file);
  const reopened = createObserverStore({ dataDir: f.dataDir, now: f.now }); assert.equal(reopened.get(saved.id), undefined); assert.equal(reopened.state().tombstones[0].cleanupPending, false); reopened.dispose();
});

test("source content, repository bytes and model config changes invalidate evidence; run TTL does not expire a saved finding", async t => {
  const f = fixture(t), saved = await finding(f);
  f.advance(121000); assert.equal(f.store.get(saved.id)?.validity, "current", "capability duration is separate from evidence validity");
  f.store.updateSettings(f.store.settings().revision, { model: { provider: "fixture", model: "selected-model", configRevision: "config-2" } }, "authorized-session");
  assert.equal(f.store.get(saved.id)?.validity, "stale"); assert.throws(() => f.store.review({ id: saved.id, revision: saved.revision, status: "accepted" }, "session"), /observer_finding_invalid/);
  const run = f.reserve(), cap = f.queries.createCapability(run); await f.queries.execute(cap, { type: "session_read", source: f.source });
  f.conversations[0].events[0].text = "Changed public source";
  await assert.rejects(f.queries.beforePublication(f.store.getRun(run.id)!, { factIds: [], evidenceIds: [] }), /observer_source_changed/);
  writeFileSync(join(f.repoRoot, "src/main.ts"), "changed published bytes"); await assert.rejects(f.queries.execute(cap, { type: "repo_read", path: "src/main.ts" }), /observer_source_changed/);
});

test("concurrent queries respect cumulative budgets and cancellation; failed/cancelled model requests remain charged across restart", async t => {
  const f = fixture(t); const budget: ObserverBudget = { ...f.store.settings().budget, maxQueries: 1, dailyRequests: 1 };
  f.store.updateSettings(f.store.settings().revision, { budget, background: true }, "background-config-authorization");
  const run = f.reserve(), cap = f.queries.createCapability(run);
  const results = await Promise.allSettled([f.queries.execute(cap, { type: "sessions_list" }), f.queries.execute(cap, { type: "sessions_list" })]); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  f.store.chargeModelRequest(run.id); f.store.recordUsage(run.id, { unknownUsage: 1 }); f.store.finishRun(run.id, "cancelled");
  const next = f.reserve(); assert.throws(() => f.store.chargeModelRequest(next.id), /observer_budget_exhausted/);
  const reopened = createObserverStore({ dataDir: f.dataDir, now: f.now }); assert.equal(reopened.settings().background, false); assert.equal(reopened.getRun(next.id)?.status, "interrupted"); assert.equal(reopened.state().requests, 1); assert.equal(reopened.getRun(run.id)?.spent.unknownUsage, 1);
  assert.equal(statSync(f.store.root).mode & 0o777, 0o700); assert.equal(statSync(join(f.store.root, "state.json")).mode & 0o777, 0o600); reopened.dispose();
  const abort = new AbortController(); abort.abort(); const stopped = f.queries.createCapability(next, abort.signal); await assert.rejects(f.queries.execute(stopped, { type: "sessions_list" }), /observer_capability_revoked/);
});

test("aggregate counts separate errors, cancellations and business outcomes and allow no-findings reports", async t => {
  const f = fixture(t), run = f.reserve({ level: "L1" }), cap = f.queries.createCapability(run);
  const result = await f.queries.execute(cap, { type: "aggregate_runs", since: f.now() - 86400000, until: f.now() });
  assert.equal(result.facts[0].value.executionErrors, 1); assert.equal(result.facts[0].value.businessOutcome, "unknown");
  assert.deepEqual(f.store.commitReport(run.id, { report: "The public sample contains one execution error; business outcome is unknown.", proposals: [] }), []);
  assert.equal(f.store.getRun(run.id)?.status, "no_findings");
});

test("scoped log evidence rejects unrelated/deleted generations, supports bounded replay, and rejects rotation before publication", async t => {
  const f = fixture(t), other = f.store.registerSource("unrelated", "birth");
  let logs = [{ id: "allowed", segment: "segment-1", source: f.source, at: f.now(), event: "tool.decision", tool: "write", decision: "refused", runId: "run-1" },
    { id: "unrelated", segment: "segment-1", source: other, at: f.now(), event: "tool.decision", tool: "private-tool", decision: "denied", runId: "private-run" }];
  const queries = createObserverQueries({ store: f.store, repo: f.repo, now: f.now, conversations: () => f.conversations, logs: () => logs }); t.after(() => queries.dispose());
  const run = f.reserve(), cap = queries.createCapability(run); const result = await queries.execute(cap, { type: "logs" });
  assert.match(result.content, /allowed/); assert.doesNotMatch(result.content, /unrelated|private-tool|private-run/);
  const proposal: FindingProposal = { kind: "project_suggestion", title: "Review policy refusal", inference: "A scoped refusal was observed.", factIds: result.facts.map(item => item.id), proposedAction: { kind: "inspect", target: { kind: "project", id: "current_project" }, description: "Review the scoped policy result.", verificationRefs: result.evidenceRefs.map(item => item.id) } };
  await queries.beforePublication(f.store.getRun(run.id)!, { factIds: proposal.factIds, evidenceIds: proposal.proposedAction.verificationRefs });
  const saved = f.store.commitReport(run.id, { report: "Observed refusal.", proposals: [proposal] })[0];
  assert.match((await queries.openEvidence(saved.id, saved.revision, saved.evidenceRefs[0].id)).text, /allowed/);
  logs = []; await assert.rejects(queries.openEvidence(saved.id, saved.revision, saved.evidenceRefs[0].id), /observer_evidence_missing/);
  f.store.beginSourceDeletion(f.source); assert.equal(f.store.get(saved.id), undefined);
});

test("config and usage evidence are revalidated at publication and opened only while their exact snapshot exists", async t => {
  const f = fixture(t); let config = { provider: "fixture", configRevision: "actual-1" }, usage = { inputTokens: 42, outputTokens: null };
  const queries = createObserverQueries({ store: f.store, repo: f.repo, now: f.now, conversations: () => f.conversations, config: () => config, usage: () => usage }); t.after(() => queries.dispose());
  const run = f.reserve(), cap = queries.createCapability(run); const result = await queries.execute(cap, { type: "usage" });
  const proposal: FindingProposal = { kind: "project_suggestion", title: "Missing reported usage", inference: "Output usage is unknown.", factIds: result.facts.map(item => item.id), proposedAction: { kind: "inspect", target: { kind: "project", id: "current_project" }, description: "Inspect the usage gap.", verificationRefs: result.evidenceRefs.map(item => item.id) } };
  const saved = f.store.commitReport(run.id, { report: "Usage gap.", proposals: [proposal] })[0];
  assert.equal(JSON.parse((await queries.openEvidence(saved.id, saved.revision, saved.evidenceRefs[0].id)).text).inputTokens, 42);
  usage = { inputTokens: 43, outputTokens: null }; await assert.rejects(queries.openEvidence(saved.id, saved.revision, saved.evidenceRefs[0].id), /observer_source_changed/);
  const next = f.reserve(), nextCap = queries.createCapability(next); await queries.execute(nextCap, { type: "config" }); config = { ...config, configRevision: "actual-2" };
  await assert.rejects(queries.beforePublication(f.store.getRun(next.id)!, { factIds: [], evidenceIds: [] }), /observer_source_changed/);
});

test("pagination is bound to query and fixed source versions; changed source cannot mix pages", async t => {
  const f = fixture(t); f.store.updateSettings(f.store.settings().revision, { budget: { ...f.store.settings().budget, pageSize: 1 } }, "session");
  const run = f.reserve(), cap = f.queries.createCapability(run), first = await f.queries.execute(cap, { type: "session_read", source: f.source }); assert.equal(first.nextCursor, 1);
  await assert.rejects(f.queries.execute(cap, { type: "repo_list", cursor: first.nextCursor }), /observer_cursor_invalid/);
  f.conversations[0].events[0].text = "new content version";
  await assert.rejects(f.queries.execute(cap, { type: "session_read", source: f.source, cursor: first.nextCursor }), /observer_source_changed/);
});

test("model output rejects extra executable fields, mismatched target categories and dangling evidence; review preserves original authorization", async t => {
  const f = fixture(t), run = f.reserve({ requestedBy: "user_session", authorizedVia: "original-run-authorization" }), cap = f.queries.createCapability(run);
  const a = await f.queries.execute(cap, { type: "repo_read", path: "src/main.ts" }); const b = await f.queries.execute(cap, { type: "config" });
  const proposal = f.proposal(f.store.getRun(run.id)!);
  for (const action of [{ ...proposal.proposedAction, command: "arbitrary shell" }, { ...proposal.proposedAction, target: { kind: "configuration", id: "arbitrary.setting" } }, { ...proposal.proposedAction, target: { kind: "experience", id: "conversation" } }])
    assert.throws(() => f.store.commitReport(run.id, { report: "bad", proposals: [{ ...proposal, proposedAction: action as never }] }), /observer_action_invalid/);
  assert.throws(() => f.store.commitReport(run.id, { report: "bad", proposals: [{ ...proposal, factIds: a.facts.map(item => item.id), proposedAction: { ...proposal.proposedAction, verificationRefs: b.evidenceRefs.map(item => item.id) } }] }), /observer_action_invalid/);
  const saved = f.store.commitReport(run.id, { report: "Reviewable.", proposals: [proposal] })[0]; const accepted = f.store.review({ id: saved.id, revision: saved.revision, status: "accepted" }, "reviewer-authorization");
  assert.equal(accepted.authorizedVia, "original-run-authorization"); assert.equal(accepted.reviewAuthorization, "reviewer-authorization"); assert.equal(accepted.approvedRevision, saved.revision);
});

test("repeated supported findings explicitly supersede prior approvals without inheriting acceptance; deleting private history frees run metadata", async t => {
  const f = fixture(t), first = await finding(f); f.store.review({ id: first.id, revision: 1, status: "accepted" }, "reviewer");
  const second = await finding(f); assert.equal(second.supersedes, first.id); assert.equal(second.reviewStatus, "pending"); assert.equal(f.store.get(first.id)?.validity, "stale");
  const run = f.reserve({ conversationId: "observer:history", clientRequestId: "request", question: "A bounded question" }); f.store.commitReport(run.id, { report: "No finding.", proposals: [] });
  f.store.renameConversation("observer:history", "Renamed private history"); assert.equal(f.store.getRun(run.id)?.title, "Renamed private history");
  assert.throws(() => f.reserve({ conversationId: "observer:history", clientRequestId: "request", question: "A different question" }), /observer_request_conflict/);
  f.store.deleteConversation("observer:history"); assert.equal(f.store.getRun(run.id), undefined);
  assert.equal("files" in second.buildStamp, false); assert.equal("files" in f.store.getRun(second.observerRunId)!.buildStamp, false);
  assert.equal(statSync(join(f.store.root, "manifests", `${f.repo.buildStamp.manifestHash}.json`)).mode & 0o777, 0o600);
});

test("aggregate denominator counts runs, excludes unknown timestamps, and reports routine policy and duration baseline gaps", async t => {
  const f = fixture(t); f.conversations[0].events.push({ id: "other-run", type: "terminal", runId: "run-2", status: "cancelled", at: f.now() }); f.conversations[0].events.push({ id: "no-time", type: "terminal", runId: "run-unknown", status: "success" });
  const queries = createObserverQueries({ store: f.store, repo: f.repo, now: f.now, conversations: () => f.conversations,
    logs: () => [{ source: f.source, at: f.now(), event: "tool.decision", tool: "write", decision: "refused", runId: "run-1" }],
    routines: () => [{ id: "routine", botId: "assistant", failureCount: 2, history: [{ at: f.now() - 4, status: "failed", durationMs: 100, conversationId: "conversation" }, { at: f.now() - 3, status: "failed", durationMs: 100, conversationId: "conversation" }, { at: f.now() - 2, status: "failed", durationMs: 100, conversationId: "conversation" }, { at: f.now() - 1, status: "failed", durationMs: 5000, conversationId: "conversation" }] }] }); t.after(() => queries.dispose());
  const run = f.reserve(), cap = queries.createCapability(run), result = await queries.execute(cap, { type: "aggregate_runs", since: f.now() - 86400000, until: f.now() }); const stats = result.facts[0].value;
  assert.equal(stats.samples, 2); assert.equal(stats.denominator, 2); assert.equal(stats.numerator, 1); assert.equal(stats.cancelled, 1); assert.equal(stats.completed, 0); assert.equal(stats.unknownTimeSamples, 1); assert.equal(stats.policyDenied, 1);
  const routine = (stats.routineAnomalies as { consecutiveFailures: number; slowRuns: number }[])[0]; assert.equal(routine.consecutiveFailures, 4); assert.equal(routine.slowRuns, 1);
});

test("background toggle preserves manual capability; actual model changes invalidate it and generation tombstones cannot be bypassed by re-registering old birth", async t => {
  const f = fixture(t), run = f.reserve(), cap = f.queries.createCapability(run);
  f.store.updateSettings(f.store.settings().revision, { background: true, windowDays: 14 }, "background-authorized");
  await assert.rejects(f.queries.execute(cap, { type: "sessions_list" }), /observer_snapshot_stale/);
  f.store.finishRun(run.id, "cancelled"); const manual = f.reserve(), manualCap = f.queries.createCapability(manual);
  f.store.updateSettings(f.store.settings().revision, { background: false }, "background-revoked"); await f.queries.execute(manualCap, { type: "sessions_list" });
  f.store.setCurrentModelRevision("different-actual-model-revision"); await assert.rejects(f.queries.execute(manualCap, { type: "sessions_list" }), /observer_snapshot_stale/);
  f.store.beginSourceDeletion(f.source); assert.deepEqual(f.store.registerSource("conversation", "persistent-conversation-generation-1"), f.source); assert.equal(f.store.sourceValid(f.source), false);
});

test("manifest metadata is private, deduplicated and bounded across build refreshes; conflicting existing manifest is never trusted", t => {
  const f = fixture(t);
  for (let index = 0; index < 25; index++) {
    writeFileSync(join(f.repoRoot, "src/main.ts"), `public build ${index}`); writeFileSync(f.manifestPath, JSON.stringify(createManifest(f.repoRoot, ["src/main.ts"])));
    f.store.setRepoSnapshot(createRepoSnapshot({ root: f.repoRoot, manifestPath: f.manifestPath }));
  }
  const state = f.store.state(); assert.equal(state.manifestHashes?.length, 1);
  assert.equal(readdirSync(join(f.store.root, "manifests")).length, 1);
  const otherRoot = join(f.root, "collision-data"), another = createObserverStore({ dataDir: otherRoot }); mkdirSync(join(another.root, "manifests"), { recursive: true }); writeFileSync(join(another.root, "manifests", `${f.repo.buildStamp.manifestHash}.json`), "corrupt collision");
  assert.throws(() => another.setRepoSnapshot(f.repo), /observer_storage_unavailable/); another.dispose();
  assert.equal(allowedManifestPath("docs/中文文档.md"), true); assert.equal(allowedManifestPath("src\\private.ts"), false); assert.equal(allowedManifestPath("src/invalid\nname.ts"), false);
});

test("async manifest creation and repository verification yield to cancellation instead of blocking ordinary host work", async t => {
  const f = fixture(t), { createRepoSnapshotAsync, verifyRepoSnapshotAsync } = await import("./observer/version.ts");
  writeFileSync(join(f.repoRoot, "src/second.ts"), "another bounded source"); const manifest = createManifest(f.repoRoot, ["src/main.ts", "src/second.ts"]); writeFileSync(f.manifestPath, JSON.stringify(manifest));
  const controller = new AbortController(); const creating = createRepoSnapshotAsync({ root: f.repoRoot, manifestPath: f.manifestPath, signal: controller.signal }); setImmediate(() => controller.abort());
  await assert.rejects(creating, /observer_cancelled/);
  const verified = await createRepoSnapshotAsync({ root: f.repoRoot, manifestPath: f.manifestPath }); assert.equal(verified.buildStamp.manifestHash, manifest.manifestHash);
  const abort = new AbortController(); let foreground = false; const checking = verifyRepoSnapshotAsync(verified, { signal: abort.signal }); setImmediate(() => { foreground = true; abort.abort(); }); await assert.rejects(checking, /observer_cancelled/); assert.equal(foreground, true);
});

test("default no-Git deployment discovers its package manifest and refuses a malformed manifest without fallback", async t => {
  const f = fixture(t), { createRepoSnapshotAsync } = await import("./observer/version.ts");
  assert.equal(createRepoSnapshot({ root: f.repoRoot }).buildStamp.manifestHash, f.repo.buildStamp.manifestHash);
  assert.equal((await createRepoSnapshotAsync({ root: f.repoRoot })).buildStamp.manifestHash, f.repo.buildStamp.manifestHash);
  writeFileSync(f.manifestPath, "malformed manifest"); assert.throws(() => createRepoSnapshot({ root: f.repoRoot }), /observer_manifest_invalid/); await assert.rejects(createRepoSnapshotAsync({ root: f.repoRoot }), /observer_manifest_invalid/);
});

test("metadata byte quota rejects incremental query growth without corrupting storage; terminal and deletion writes retain reserved space", t => {
  const f = fixture(t); f.store.updateSettings(f.store.settings().revision, { budget: { ...f.store.settings().budget, maxQueries: 200, maxBytes: 4 * 1024 * 1024 } }, "session");
  const template = f.reserve(); f.store.finishRun(template.id, "failed");
  const file = join(f.store.root, "state.json"), state = JSON.parse(readFileSync(file, "utf8"));
  // A valid, large host-metadata history models a prior process near the persistent byte quota.
  state.runs = Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(state.runs[0]), id: `history-${index}`, status: "failed", facts: [], queryRecords: [], evidenceRefs: [] }));
  const targetBytes = 18 * 1024 * 1024 - 10000, emptyBytes = Buffer.byteLength(JSON.stringify(state));
  const item = { id: "metric", runId: "history-0", kind: "host_counter", value: { paddedMetric: "x".repeat(20000) }, evidenceIds: [] };
  const count = Math.floor((targetBytes - emptyBytes) / (Buffer.byteLength(JSON.stringify(item)) + 1));
  for (let index = 0; index < count; index++) { const run = state.runs[index % state.runs.length]; run.facts.push({ ...item, id: `metric-${index}`, runId: run.id }); }
  let raw = JSON.stringify(state); const adjustment = targetBytes - Buffer.byteLength(raw), last = state.runs[0].facts.at(-1); last.value.paddedMetric = last.value.paddedMetric.slice(0, Math.max(0, last.value.paddedMetric.length + Math.min(0, adjustment))); raw = JSON.stringify(state); writeFileSync(file, raw);
  const reopened = createObserverStore({ dataDir: f.dataDir, now: f.now }); const run = reopened.reserveRun({ level: "L2", requestedBy: "user_session", authorizedVia: "session", sourceScope: [f.source], repo: f.repo, instructionVersion: "v1" });
  const before = readFileSync(file, "utf8");
  assert.throws(() => reopened.recordQuery(run.id, { content: "", bytes: 32000, facts: [{ id: "new-metric", runId: run.id, kind: "host_counter", value: { paddedMetric: "x".repeat(31000) }, evidenceIds: [] }], evidenceRefs: [], queryRecord: { id: "new-query", type: "aggregate_runs", at: f.now(), implementationVersion: 1, evidenceIds: [], bytes: 32000, parameters: {}, reproducible: true } }), /observer_metadata_full/);
  assert.equal(reopened.storageError, undefined); assert.equal(readFileSync(file, "utf8"), before);
  reopened.finishRun(run.id, "failed"); reopened.beginSourceDeletion(f.source); assert.equal(reopened.state().tombstones.length, 1); assert.ok(statSync(file).size < 100000); reopened.dispose();
  const restored = createObserverStore({ dataDir: f.dataDir, now: f.now }); assert.equal(restored.storageError, undefined); assert.equal(restored.sourceValid(f.source), false); restored.dispose();
});

test("denied attempts consume shared run query budget and persist bounded fixed-code metadata without raw parameters", async t => {
  const f = fixture(t); f.store.updateSettings(f.store.settings().revision, { budget: { ...f.store.settings().budget, maxQueries: 2 } }, "session"); const run = f.reserve(), a = f.queries.createCapability(run), b = f.queries.createCapability(run);
  await assert.rejects(f.queries.execute(a, { type: "repo_read", path: "../RAW-PRIVATE-ARGUMENT" }), /observer_path_denied/);
  await assert.rejects(f.queries.execute(b, { type: "repo_read", path: "../RAW-PRIVATE-ARGUMENT" }), /observer_path_denied/);
  await assert.rejects(f.queries.execute(a, { type: "repo_list" }), /observer_budget_exhausted/);
  assert.equal(f.store.getRun(run.id)?.spent.queries, 2); const state = f.store.state(); assert.ok(state.queryRejections?.some(item => item.runId === run.id && item.code === "observer_path_denied")); assert.doesNotMatch(readFileSync(join(f.store.root, "state.json"), "utf8"), /RAW-PRIVATE-ARGUMENT/);
});

test("repository search reports skipped secret files and read ranges beyond EOF never create negative facts", async t => {
  const f = fixture(t); writeFileSync(join(f.repoRoot, "src/private-example.ts"), "password: clearly-private-value"); writeFileSync(f.manifestPath, JSON.stringify(createManifest(f.repoRoot, ["src/main.ts", "src/private-example.ts"]))); const repo = createRepoSnapshot({ root: f.repoRoot });
  const queries = createObserverQueries({ store: f.store, repo, now: f.now, conversations: () => f.conversations }); t.after(() => queries.dispose());
  const run = f.reserve({ repo }), cap = queries.createCapability(run); const search = await queries.execute(cap, { type: "repo_search", text: "absent term" }); assert.equal(search.facts[0].value.count, 0); assert.equal(search.facts[0].value.skippedFiles, 1); assert.equal(search.facts[0].value.complete, false); assert.doesNotMatch(search.content, /clearly-private/);
  await assert.rejects(queries.execute(cap, { type: "repo_read", path: "src/main.ts", startLine: 999, lines: 10 }), /observer_line_range_invalid/);
});
