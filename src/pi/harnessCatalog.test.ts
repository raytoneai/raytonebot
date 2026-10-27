import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicBaseUrlForProvider } from "./harnessCatalog.ts";

test("Anthropic routing preserves custom endpoints and only translates official DeepSeek URLs", () => {
  const provider = { id: "deepseek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" };
  for (const baseUrl of ["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1/"]) {
    assert.equal(anthropicBaseUrlForProvider({ ...provider, baseUrl }), "https://api.deepseek.com/anthropic");
  }
  assert.equal(anthropicBaseUrlForProvider({ ...provider, baseUrl: "https://proxy.example/v1" }), undefined,
    "an OpenAI-compatible proxy has no implied Anthropic endpoint");
  assert.equal(anthropicBaseUrlForProvider({ ...provider, baseUrl: "https://proxy.example/anthropic/v1", protocol: "anthropic" }),
    "https://proxy.example/anthropic");
  assert.equal(anthropicBaseUrlForProvider({ ...provider, baseUrl: "https://api.deepseek.com.evil.example/v1" }), undefined);
  assert.equal(anthropicBaseUrlForProvider({ ...provider, baseUrl: "https://api.deepseek.com/custom" }), undefined);
});
