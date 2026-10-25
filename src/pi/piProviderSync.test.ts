import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderConnection } from "../schema/agentuxConfig.ts";
import { piRuntimeConfigurationForProvider } from "./piProviderSync.ts";

test("provider sync preserves per-model capabilities without changing selection or sending a key by default", () => {
  const provider = createProviderConnection("custom");
  provider.defaultModel = " long-model ";
  provider.models = ["long-model", "text-model"];
  provider.modelOptions = { " long-model ": { contextWindow: 256_000, maxTokens: 32_000, reasoning: true }, "text-model": { input: ["text"] } };
  const configuration = piRuntimeConfigurationForProvider(provider);
  assert.equal(configuration.model, "long-model");
  assert.deepEqual(configuration.providerDefinition?.models, ["long-model", "text-model"]);
  assert.deepEqual(configuration.providerDefinition?.modelOptions, {
    "long-model": { contextWindow: 256_000, maxTokens: 32_000, reasoning: true }, "text-model": { input: ["text"] },
  });
  assert.equal(configuration.apiKey, undefined);
  assert.equal(configuration.clearApiKey, undefined);
  assert.equal(provider.defaultModel, " long-model ", "sync must leave the editable draft unchanged");
  provider.modelOptions[" long-model "].maxTokens = 512_000;
  assert.throws(() => piRuntimeConfigurationForProvider(provider), /maxTokens/);
});

test("old providers omit metadata and orphaned metadata cannot silently enter the runtime", () => {
  const provider = createProviderConnection("deepseek");
  assert.equal(Object.hasOwn(piRuntimeConfigurationForProvider(provider).providerDefinition!, "modelOptions"), false);
  provider.modelOptions = { "unknown-model": { contextWindow: 64_000 } };
  assert.throws(() => piRuntimeConfigurationForProvider(provider), /model options ID/);
});
