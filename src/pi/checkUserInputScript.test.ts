import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createQuestionAnswerRequest } from "../../scripts/check-user-input.mjs";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { pendingUserInput } from "../runtime/userInput.ts";

// Exercise the standalone script's actual auth path, without native CLI or model dependencies.
test("standalone user-input check authenticates before preserving HTTP validation and answer idempotency", async t => {
  const root = mkdtempSync(join(tmpdir(), "rtb-input-script-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridgeFactory: PiBridgeFactory = async ({ onUserInput }) => ({
    subscribe: () => () => {}, abort: async () => {}, configure: async () => {}, dispose() {}, newSession: async () => {}, state: async () => ({ models: [], tools: [] }),
    prompt: async () => { await onUserInput({ toolCallId: "script-question", signal: new AbortController().signal,
      questions: [{ id: "language", header: "Language", question: "Which language?", options: [{ label: "中文", description: "Chinese" }, { label: "English", description: "English" }], allowOther: false, multiSelect: false }] }); },
  });
  const host = createPiHttpHost({ cwd: root, dataDir: join(root, "data"), browser: false, routineClock: false, vaultDir: join(root, "vault"), bridgeFactory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  let running: Promise<void> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const answer = await createQuestionAnswerRequest(host, origin);
    let announced!: () => void;
    const waiting = new Promise<void>(resolve => { announced = resolve; });
    running = host.controller.runPrompt({ conversationId: "script", requestId: "script-run", prompt: "Synthetic question" }, event => { if (event.type === "run.awaiting_input") announced(); }, { signal: AbortSignal.timeout(5000) });
    await Promise.race([waiting, running.then(() => { throw new Error("Expected a real pending question"); })]);
    const question = pendingUserInput(host.controller.getConversation("script")!.events)!;
    const body = JSON.stringify({ conversationId: "script", requestId: question.requestId, answers: null });
    const rejectedHeaders: Record<string, string>[] = [{}, { cookie: "raytone_control=wrong", "x-raytonebot-csrf": "wrong" }];
    for (const headers of rejectedHeaders) {
      assert.equal((await fetch(`${origin}/__agentcanvas/pi/input`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })).status, 401);
      assert.equal(pendingUserInput(host.controller.getConversation("script")!.events)?.requestId, question.requestId);
    }
    assert.equal((await answer("wrong", question.requestId, null)).status, 409);
    assert.equal((await answer("script", question.requestId, {})).status, 400);
    const response = { language: ["中文"] };
    assert.equal((await answer("script", question.requestId, response)).status, 200);
    assert.equal((await answer("script", question.requestId, response)).status, 200);
    assert.equal((await answer("script", question.requestId, null)).status, 409);
    await running;
    assert.equal(pendingUserInput(host.controller.getConversation("script")!.events), undefined);
  } finally {
    await host.dispose(); await running;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
