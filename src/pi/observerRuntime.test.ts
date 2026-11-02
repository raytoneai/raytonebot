import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManifest } from "../../scripts/observer-manifest.mjs";
import { explainObserverFacts, parseObserverAnalysis, type ObserverModel } from "./observer/analysis.ts";
import { runObserverDiagnostic } from "./observer/diagnostic.ts";
import { publicProjection } from "./observer/evidence.ts";
import { createObserverService } from "./observer/service.ts";
import { createObserverStore } from "./observer/store.ts";
import { createRepoSnapshot } from "./observer/version.ts";
import type { ConversationProjection, FindingProposal, HostFact } from "./observer/types.ts";
const model: ObserverModel = { definition: { id: "fixture", name: "Fixture", protocol: "openai-compatible", authMode: "none", baseUrl: "https://model.example/v1", models: ["model"] }, model: "model", configRevision: "model-1" };
const authorization = { requestedBy: "user_session", authorizedVia: "session-id", scope: "developer", version: 1, at: Date.now() } as const;
const proposal = (facts: readonly HostFact[], code = false): FindingProposal => ({ kind: "project_suggestion", title: "Verify the result", inference: "The host observed a condition that warrants a test.", factIds: facts.map(fact => fact.id), proposedAction: { kind: code ? "add_test" : "inspect", target: { kind: code ? "code" : "project", id: code ? "src/demo.ts" : "current_project" }, description: "Verify the condition against a focused test.", verificationRefs: facts.flatMap(fact => fact.evidenceIds) } });
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rtb-observer-runtime-")), repoRoot = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(join(repoRoot, "src"), { recursive: true }); writeFileSync(join(repoRoot, "src/demo.ts"), "export const value = 'SOURCE_RAW_PAYLOAD';\n");
  const manifestPath = join(repoRoot, "OBSERVER-BUILD.json"); writeFileSync(manifestPath, JSON.stringify(createManifest(repoRoot, ["src/demo.ts"])));
  const store = createObserverStore({ dataDir }); const selected = { provider: "fixture", model: "model", configRevision: "model-1" };
  store.updateSettings(0, { enabled: true, background: false, model: selected }, "session-id");
  const source = store.registerSource("chat", "generation-one"), second = store.registerSource("other", "generation-two");
  let conversations: ConversationProjection[] = [source, second].map((source, index) => publicProjection({ source, version: "", botId: "assistant", harness: "pi", createdAt: Date.now() - 1000, updatedAt: Date.now(), events: [{ id: `end-${index}`, runId: `turn-${index}`, type: "terminal", status: index ? "cancelled" : "error", at: Date.now() }] }));
  let calls = 0;
  const options = { store, appRoot: repoRoot, repo: () => createRepoSnapshot({ root: repoRoot, manifestPath }), models: () => [{ ...selected, label: "Fixture", available: true }], resolveModel: () => model,
    leaseModel: async () => ({ baseUrl: "http://fixture.invalid/v1", apiKey: "dummy", revoke() {} }), conversations: () => conversations, submitLesson() {}, idleMs: 1,
    explain: async (input: Parameters<typeof explainObserverFacts>[0]) => { calls++; input.chargeRequest(); input.onUsage({ inputTokens: 10, outputTokens: 4 }); return { report: "Host statistics describe execution, not business success.", proposals: [proposal(input.facts)] }; },
    diagnose: async (input: Parameters<typeof runObserverDiagnostic>[0]) => { calls++; input.chargeRequest(); const result = await input.execute({ type: "repo_read", path: "src/demo.ts", lines: 1 }, input.signal); return { report: "A focused test can verify the exported result.", proposals: [proposal(result.facts, true)] }; } };
  return { root, repoRoot, dataDir, manifestPath, store, source, second, options, get calls() { return calls; }, get conversations() { return conversations; }, set conversations(value: ConversationProjection[]) { conversations = value; }, close() { store.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test("L1 has one bounded tool-free request, reports usage, and rejects forged facts or redirect following", async () => {
  const facts: HostFact[] = [{ id: "host-fact", runId: "run", kind: "run_statistics", value: { samples: 2, executionErrors: 1, cancelled: 1, businessOutcome: "unknown" }, evidenceIds: ["host-evidence"] }];
  let calls = 0, charged = 0, usage: unknown;
  const result = await explainObserverFacts({ model, facts, signal: new AbortController().signal, chargeRequest: () => charged++, onUsage: value => { usage = value; }, fetcher: async (_url, init) => {
    calls++; assert.equal(init?.redirect, "error"); const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 1000); assert.equal(body.tools, undefined); assert.match(body.messages[1].content, /businessOutcome/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ report: "One recorded execution failed; the cancellation is distinct.", proposals: [] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  } });
  assert.equal(calls, 1); assert.equal(charged, 1); assert.deepEqual(usage, { inputTokens: 20, outputTokens: 10 }); assert.deepEqual(result.proposals, []);
  assert.throws(() => parseObserverAnalysis(JSON.stringify({ report: "Forged", proposals: [proposal([{ ...facts[0], id: "forged" }])] }), facts), /observer_fact_invalid/);
  assert.throws(() => parseObserverAnalysis(JSON.stringify({ report: "Forged", facts: [], proposals: [] }), facts), /observer_model_output_invalid/);
});

test("L1/L2 persist reports only, reconstruct report artifacts, deduplicate requests and reject stale review/handoff", async () => {
  const f = fixture(), service = createObserverService(f.options);
  try {
    const events: unknown[] = [];
    await service.run({ question: "Inspect the example", conversationId: "observer:diagnostic", clientRequestId: "client-id", authorization, onEvent: event => events.push(event) });
    assert.equal(f.calls, 1); assert.ok(events.some((event: any) => event.type === "artifact.created"));
    const saved = await service.conversation("observer:diagnostic"); assert.ok(saved.events.some(event => event.type === "artifact.created")); assert.deepEqual(saved.acceptedRequestIds, ["client-id"]);
    await service.run({ question: "Inspect the example", conversationId: "observer:diagnostic", clientRequestId: "client-id", authorization, onEvent() {} }); assert.equal(f.calls, 1);
    assert.doesNotMatch(readFileSync(join(f.dataDir, "observer/state.json"), "utf8"), /SOURCE_RAW_PAYLOAD|fixture.invalid|dummy/);
    const finding = f.store.list()[0]; await service.update({ action: "review", id: finding.id, revision: finding.revision, status: "accepted" }, authorization);
    const accepted = f.store.get(finding.id)!; const shared = await service.update({ action: "handoff", id: accepted.id, revision: accepted.revision, botId: "assistant", scope: "Inspect the suggested test only" }, authorization) as any;
    const tools = await service.handoffTools(shared.handoff.token, "assistant", "ordinary-run", () => true);
    assert.equal((await tools.run("observer_finding", {})).isError, false);
    await assert.rejects(service.handoffTools(shared.handoff.token, "assistant", "different-run", () => true), /observer_handoff_invalid/);
    service.revokeAuthorization("session-id"); assert.equal((await tools.run("observer_finding", {})).isError, true);
    writeFileSync(join(f.repoRoot, "src/demo.ts"), "changed bytes\n");
    await assert.rejects(service.update({ action: "review", id: accepted.id, revision: accepted.revision, status: "accepted" }, authorization), /observer_source_changed|observer_manifest_invalid|observer_finding_invalid/);
  } finally { await service.dispose(); f.close(); }
});

test("background observes only new source batches and advances watermarks only after durable completion", async () => {
  const f = fixture(), service = createObserverService(f.options);
  try {
    await service.update({ action: "settings", revision: f.store.settings().revision, enabled: true, backgroundEnabled: true, model: { provider: "fixture", model: "model" }, budgets: f.store.settings().budget, windowDays: 7 }, authorization);
    service.completed("chat", "new-version"); await until(() => f.store.runs().some(run => run.status === "success"));
    const run = f.store.runs()[0]; assert.equal(run.requestedBy, "background"); assert.deepEqual(run.sourceScope.map(source => source.conversationId), ["chat"]); assert.match(f.store.handled("chat")!, /^new-version\|/);
    service.completed("chat", "new-version"); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.calls, 1);
  } finally { await service.dispose(); f.close(); }
});

test("developer revocation cancels manual work; disabling background preserves a manual run and disabled platforms cannot start L2", async () => {
  const f = fixture(); let release!: () => void, started = false;
  const service = createObserverService({ ...f.options, diagnose: async input => { started = true; input.chargeRequest(); const result = await input.execute({ type: "repo_read", path: "src/demo.ts", lines: 1 }, input.signal); await new Promise<void>((resolve, reject) => { release = resolve; input.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); }); return { report: "A supported report.", proposals: [proposal(result.facts, true)] }; } });
  try {
    const pending = service.run({ question: "Inspect", conversationId: "observer:manual", clientRequestId: "manual", authorization, onEvent() {} }); await until(() => typeof release === "function");
    await service.update({ action: "settings", revision: f.store.settings().revision, enabled: true, backgroundEnabled: false, model: { provider: "fixture", model: "model" }, budgets: f.store.settings().budget, windowDays: 7 }, authorization);
    assert.equal(f.store.runs()[0].status, "running"); release(); await pending; assert.equal(f.store.runs()[0].status, "success");
    started = false; const second = service.run({ question: "Again", conversationId: "observer:manual", clientRequestId: "manual-2", authorization, onEvent() {} }); await until(() => started); service.revokeAuthorization("session-id"); await second; assert.equal(f.store.runs()[1].status, "cancelled");
    const cloud = createObserverService({ ...f.options, allowL2: false }); try { assert.equal((await cloud.view()).l2Available, false); await assert.rejects(cloud.run({ question: "Inspect", conversationId: "observer:cloud", authorization, onEvent() {} }), /observer_l2_platform_unverified/); } finally { await cloud.dispose(); }
  } finally { await service.dispose(); f.close(); }
});

test("actual Pi SDK uses memory only, exposes query tools only, and does not load local context or extensions", async () => {
  const f = fixture(), facts: HostFact[] = []; const requests: any[] = [];
  mkdirSync(join(f.repoRoot, ".pi/extensions"), { recursive: true }); writeFileSync(join(f.repoRoot, "AGENTS.md"), "PRIVATE_CONTEXT_SENTINEL"); writeFileSync(join(f.repoRoot, ".pi/extensions/private.ts"), "throw new Error('EXTENSION_MUST_NOT_RUN');");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.setHeader("content-type", "text/event-stream");
    const delta = requests.length === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "query-one", type: "function", function: { name: "observer_repo_read", arguments: JSON.stringify({ path: "src/demo.ts", startLine: 1, lines: 1 }) } }] } : { role: "assistant", content: JSON.stringify({ report: "The exported result can be tested.", proposals: [proposal(facts, true)] }) };
    res.write(`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", model: "model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", model: "model", choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); let charged = 0;
  try {
    const result = await runObserverDiagnostic({ cwd: f.repoRoot, model, lease: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "dummy" }, question: "Inspect the export", signal: new AbortController().signal, chargeRequest: () => { charged++; }, facts: () => facts,
      execute: async () => { const fact: HostFact = { id: "sdk-fact", runId: "sdk-run", kind: "repo_lines", value: { path: "src/demo.ts", lines: 1 }, evidenceIds: ["sdk-evidence"] }; facts.push(fact); return { facts: [fact], evidenceRefs: [], content: "export const value = 1;", bytes: 23, queryRecord: { id: "q", type: "repo_read", at: Date.now(), implementationVersion: 1, evidenceIds: ["sdk-evidence"], bytes: 23, parameters: { path: "src/demo.ts" }, reproducible: true } }; } });
    assert.equal(requests.length, 2); assert.equal(charged, 2); assert.equal(result.proposals.length, 1);
    for (const body of requests) { assert.ok(body.tools.every((tool: any) => tool.function.name.startsWith("observer_"))); assert.ok(!body.tools.some((tool: any) => ["bash", "read", "write", "edit", "browser"].includes(tool.function.name))); assert.equal(body.max_tokens ?? body.max_completion_tokens, 2000); assert.doesNotMatch(JSON.stringify(body.messages), /PRIVATE_CONTEXT_SENTINEL|EXTENSION_MUST_NOT_RUN/); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
