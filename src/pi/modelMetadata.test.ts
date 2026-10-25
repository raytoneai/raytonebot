import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeModelOptions, resolveModelOptions } from "./modelMetadata.ts";

test("models without metadata retain the existing Pi capabilities and provider reasoning detection", () => {
  assert.deepEqual(resolveModelOptions("old-model", undefined), {
    contextWindow: 128_000, maxTokens: 16_384, input: ["text", "image"], reasoning: false,
  });
  assert.equal(resolveModelOptions("deepseek-reasoner", undefined, true).reasoning, true);
  assert.equal(resolveModelOptions("toString", {}).contextWindow, 128_000);
});

test("custom capability overrides resolve independently for each configured model", () => {
  const options = normalizeModelOptions({
    " long-model ": { contextWindow: 1_000_000, maxTokens: 64_000, input: ["text"], reasoning: true },
    "small-model": { contextWindow: 8_192, reasoning: false },
  }, ["long-model", "small-model"]);
  assert.deepEqual(resolveModelOptions("long-model", options), {
    contextWindow: 1_000_000, maxTokens: 64_000, input: ["text"], reasoning: true,
  });
  assert.deepEqual(resolveModelOptions("small-model", options, true), {
    contextWindow: 8_192, maxTokens: 8_192, input: ["text", "image"], reasoning: false,
  });
  const first = resolveModelOptions("long-model", options);
  first.input.push("image");
  assert.deepEqual(resolveModelOptions("long-model", options).input, ["text"], "consumers cannot mutate saved capabilities");
});

test("invalid token limits, capabilities, unknown fields and model IDs are rejected", () => {
  for (const invalid of [
    null, [], "large", { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 1.5 },
    { contextWindow: 10_000_001 }, { contextWindow: Number.POSITIVE_INFINITY },
    { maxTokens: "4096" }, { maxTokens: 0 }, { maxTokens: 128_001 },
    { contextWindow: 4096, maxTokens: 4097 }, { reasoning: "true" },
    { input: [] }, { input: ["image"] }, { input: ["text", "audio"] }, { input: ["text", "text"] },
    { context_window: 128_000 }, { cost: { input: 1 } },
  ]) assert.throws(() => normalizeModelOptions({ model: invalid }, ["model"]), `Accepted ${JSON.stringify(invalid)}`);
  for (const invalid of [null, [], { " ": {} }, { "bad\nname": {} }, { model: {}, " model ": {} }, { removed: {} }]) {
    assert.throws(() => normalizeModelOptions(invalid, ["model"]));
  }
  assert.throws(() => resolveModelOptions("model", { model: { maxTokens: -1 } }));
});
