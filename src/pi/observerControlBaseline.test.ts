import { authenticatedFetch } from "./controlPlaneTestSupport.ts";
import { createModelGateway } from "./runtime/modelGateway.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createLearningService } from "./learning/service.ts";
import type { LearningState } from "./learning/types.ts";
import { createPiHttpHost } from "./piHost.ts";

// Historical RED reproduction and command results are retained in 14-control-plane-inventory.md.
test("OB-00: HTTP and real auto Pi Bash cannot self-approve; authenticated developer can approve", { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "raytone-observer-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const seed = createLearningService({ dataDir, busy: () => false, delayMs: 1 });
  try {
    seed.update({ action: "settings", revision: 0, enabled: true, reuse: false, dailyLimit: 1 });
    seed.enqueue({ conversationId: "synthetic-chat", runId: "synthetic-run", botId: "assistant", harness: "pi", evidence: "Synthetic correction: verify CSV headers.",
      review: async () => ({ proposal: { title: "CSV verification", trigger: "CSV export", lesson: "Check the exported CSV headers before reporting completion." } }) });
    for (let i = 0; i < 200 && (seed.state().running || seed.state().candidates.length !== 1); i++) await pause(5);
    assert.equal(seed.state().candidates.length, 1, "real LearningService must persist a candidate before HTTP reproduction");
  } finally { seed.dispose(); }
  const file = join(dataDir, "learning/state.json");
  const disk = () => JSON.parse(readFileSync(file, "utf8")) as LearningState;
  const initial = disk();
  assert.equal(initial.candidates[0].status, "pending");
  const host = createPiHttpHost({ cwd: root, dataDir, vaultDir: join(root, "vault"), browser: false, routineClock: false, sandboxed: false });
  const server = createServer((req, res) => { void host.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = `${origin}/__agentcanvas/pi/learning`;
    const post = (revision: number, extra: Record<string, string> = {}) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify({ action: "review", id: initial.candidates[0].id, revision, status: "approved" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal((await post(initial.revision, { origin: "https://foreign.example" })).status, 403);
    assert.deepEqual(disk(), initial, "cross-origin rejection must not mutate disk");
    assert.equal((await fetch(url)).status, 401);
    for (const extra of ([{}, { origin }, { cookie: "raytone_control=forged" }, { authorization: "Bearer forged-agent-tool-bridge" }] as Record<string, string>[])) {
      assert.equal((await post(initial.revision, extra)).status, 401);
      assert.deepEqual(disk(), initial);
    }
    const gateway = await createModelGateway({ port: 0, fetcher: async () => new Response("unused") });
    try {
      const lease = gateway.issue({ baseUrl: "https://model.example.test/v1", apiKey: "synthetic-upstream", model: "synthetic-model", protocol: "openai" });
      assert.equal((await post(initial.revision, { authorization: `Bearer ${lease.apiKey}` })).status, 401);
      assert.equal((await post(initial.revision, { "x-api-key": lease.apiKey })).status, 401);
      assert.deepEqual(disk(), initial);
      lease.revoke();
    } finally { await gateway.close(); }
    const userFetch = await authenticatedFetch(host, origin);
    assert.equal((await userFetch(url)).status, 403, "ordinary user session lacks developer scope");
    assert.deepEqual(disk(), initial);

    // Real installed Pi SDK + guarded bash + real curl + real host HTTP; only the model is controlled.
    const payload = JSON.stringify({ action: "review", id: initial.candidates[0].id, revision: initial.revision, status: "approved",
      requestedBy: "user_session", authorizedVia: "forged-developer" });
    const command = `curl --silent --show-error --output /dev/null --write-out 'OB_CONTROL_STATUS=%{http_code}' -H 'Content-Type: application/json' --data '${payload}' '${url}'`;
    let requests = 0;
    const toolResults: string[] = [];
    const model = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      for (const message of body.messages) if (message.role === "tool") toolResults.push(JSON.stringify(message));

      const first = requests++ === 0;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: `control-${requests}`, object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send(first ? { role: "assistant", tool_calls: [{ index: 0, id: "self-approval-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
        : { role: "assistant", content: "The host refused the unauthorized review." }, null);
      send({}, first ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
    });
    try {
      await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
      await host.controller.configure({ conversationId: "auto-self-review", provider: "control-fixture", model: "deepseek-flash", apiKey: "synthetic-fixture",
        providerDefinition: { id: "control-fixture", name: "Controlled local model", protocol: "openai-compatible", authMode: "required", models: ["deepseek-flash"],
          baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } });
      await host.controller.runPrompt({ conversationId: "auto-self-review", requestId: "auto-self-review-run", prompt: "Attempt the supplied local control request.", permissionMode: "auto", provider: "control-fixture", model: "deepseek-flash" }, () => {}, { title: "Control plane authorization fixture" });
      assert.equal(requests, 2, JSON.stringify(host.controller.getConversation("auto-self-review")!.events));
      assert.equal(toolResults.length, 1);
      assert.match(toolResults[0], /OB_CONTROL_STATUS=401/);
      assert.deepEqual(disk(), initial, "actual auto bash HTTP request cannot approve or increment revision");
      const events = host.controller.getConversation("auto-self-review")!.events;
      assert.ok(events.some(event => event.type === "tool.call.started"));
      assert.ok(!events.some(event => event.type === "run.awaiting_approval"), "auto shell request executes without a synthetic approval shortcut");
      assert.equal(events.at(-1)?.type, "run.finished");
    } finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }

    const developerFetch = await authenticatedFetch(host, origin, true);
    const reviewed = await developerFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal(reviewed.status, 200);
    const saved = disk();
    assert.equal(saved.lastAuthorization?.requestedBy, "user_session");
    assert.equal(saved.lastAuthorization?.scope, "developer");
    assert.notEqual(saved.lastAuthorization?.authorizedVia, "forged-developer");
    assert.match(saved.lastAuthorization!.authorizedVia, /^[a-f0-9-]{36}$/);
    assert.deepEqual(saved, { ...initial, lastAuthorization: saved.lastAuthorization, revision: initial.revision + 1, candidates: [{ ...initial.candidates[0], status: "approved", revision: (initial.candidates[0].revision ?? 0) + 1 }] });
    assert.equal((await developerFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status, 409);
    assert.deepEqual(disk(), saved);
    const reopened = createLearningService({ dataDir, busy: () => false });
    try { assert.deepEqual(reopened.state().candidates, saved.candidates); assert.equal(reopened.state().revision, saved.revision); }
    finally { reopened.dispose(); }
    t.diagnostic("Authenticated developer approval persists; anonymous/forged/real model lease and real auto Pi Bash requests leave candidate and revision unchanged. Cloud deployment isolation is unverified.");
  } finally {
    await host.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
