import test from "node:test";
import assert from "node:assert/strict";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { pendingVaultRequest } from "./vaultRequest.ts";
import { userInputEventsForReplay } from "./userInput.ts";
import { vaultResultMessage } from "../i18n/copy/vaultRequest.ts";

test("Vault's durable receipt survives request removal before the HTTP answer, without raw data", () => {
  const adapter = createPiEventAdapter({ runId: "vault-receipt" });
  const request = { requestId: "r", runId: "vault-receipt", origin: "https://example.com", expiresAt: Date.now() + 1000, items: [] };
  adapter.startUserMessage("Fill login");
  adapter.apply({ type: "vault_input_required", toolCallId: "tool", request });
  assert.equal(pendingVaultRequest(adapter.events)?.requestId, "r");
  const message = vaultResultMessage("zh", { status: "unknown", saved: true, message: "untrusted-upstream-canary" });
  adapter.apply({ type: "vault_input_resolved", toolCallId: "tool", requestId: "r", message });
  assert.equal(pendingVaultRequest(adapter.events), undefined);
  adapter.finish("success");
  const replay = userInputEventsForReplay(adapter.events);
  assert.ok(replay.some(event => event.type === "text.delta" && event.payload.delta === "已保存到 Vault，未确认填充。请接管浏览器检查。"));
  assert.ok(!JSON.stringify(replay).includes("untrusted-upstream-canary"));
});
