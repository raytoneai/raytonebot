import assert from "node:assert/strict";
import test from "node:test";

import { approvalDecision, browserInput, channelPatch, permissionMode, stringField } from "./piHttpInput.ts";

test("browser input keeps finite bounded coordinates, clamps wheel deltas, and rejects invalid shapes", () => {
  assert.deepEqual(browserInput({ kind: "mouse", type: "wheel", x: 4000, y: 0, deltaX: -9000, deltaY: 9000, button: "right" }), {
    kind: "mouse", type: "wheel", x: 4000, y: 0, button: "right", deltaX: -5000, deltaY: 5000,
  });
  for (const invalid of [
    { kind: "mouse", type: "move", x: Number.NaN, y: 1 },
    { kind: "mouse", type: "move", x: Number.POSITIVE_INFINITY, y: 1 },
    { kind: "mouse", type: "move", x: 4001, y: 1 },
    { kind: "mouse", type: "move", x: 1, y: -1 },
    { kind: "key", type: "down", key: "k".repeat(21) },
    { kind: "text", text: "x".repeat(2001) },
    null,
  ]) assert.equal(browserInput(invalid), undefined);
  assert.deepEqual(browserInput({ kind: "key", type: "up", key: "Enter" }), { kind: "key", type: "up", key: "Enter" });
  assert.deepEqual(browserInput({ kind: "text", text: "hello" }), { kind: "text", text: "hello" });
});

test("channel patches retain arbitrary bounded field names and filter malformed values", () => {
  const patch = channelPatch({
    enabled: true,
    fields: { unregistered_platform_field: "kept", empty: "", tooLong: "x".repeat(4097), number: 4 },
    access: "open", allowUsers: ["user", 7, "x".repeat(201)], agentPreset: "planner", botId: "custom-bot",
    model: { model: "m", definition: {
      id: "provider", baseUrl: "https://example.test/v1", models: ["m"], protocol: "openai-compatible", authMode: "none",
      modelOptions: { m: { contextWindow: 128_000, maxTokens: 4_096, input: ["text"], reasoning: true } }, apiKeyEnvVar: "PROVIDER_KEY",
    } },
  });
  assert.equal(patch.enabled, true);
  assert.deepEqual(patch.fields, { unregistered_platform_field: "kept", empty: "" });
  assert.equal(patch.access, "open");
  assert.deepEqual(patch.allowUsers, ["user"]);
  assert.equal(patch.agentPreset, "planner");
  assert.equal(patch.botId, "custom-bot");
  assert.deepEqual(patch.model?.definition.modelOptions, { m: { contextWindow: 128_000, maxTokens: 4_096, input: ["text"], reasoning: true } });
  assert.equal(channelPatch({ fields: { keep: "value" }, access: "closed", agentPreset: "unknown" }).access, undefined);
});

test("permission and approval parsers preserve their accepted values and fallbacks", () => {
  assert.equal(permissionMode(undefined), "request");
  assert.equal(permissionMode("invalid"), "request");
  assert.equal(permissionMode("auto"), "auto");
  assert.equal(permissionMode("allow-all"), "allow-all");
  for (const decision of ["yes", "always", "no"] as const) assert.equal(approvalDecision(decision), decision);
  assert.equal(approvalDecision("approve"), undefined);
  assert.equal(approvalDecision(null), undefined);
});

test("stringField accepts strings verbatim without coercion", () => {
  assert.equal(stringField({ value: "  text  " }, "value"), "  text  ");
  assert.equal(stringField({ value: "" }, "value"), "");
  assert.equal(stringField({ value: 5 }, "value"), undefined);
  assert.equal(stringField({ value: false }, "value"), undefined);
  assert.equal(stringField({}, "value"), undefined);
});
