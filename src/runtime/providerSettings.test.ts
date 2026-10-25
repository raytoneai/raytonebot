import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderConnection } from "../schema/agentuxConfig.ts";
import { restoreProviderSettings, serializeProviderSettings, updateProviderSettings, providerIsAdded, providerValidationIssue, normalizeProviderSettings } from "./providerSettings.ts";

const base = () => ({ defaultProviderId: "deepseek", settingsLauncher: true,
  connections: [createProviderConnection("deepseek", true), createProviderConnection("openai", false)] });

test("model service edits survive restore without persisting untouched deployment defaults or session keys", () => {
  const source = base(), changed = structuredClone(source);
  changed.connections[0].baseUrl = "https://model.example/v1";
  changed.connections[0].auth = { mode: "env", envVar: "EXAMPLE_API_KEY" };
  changed.connections[1].enabled = true;
  changed.defaultProviderId = "openai";
  Object.assign(changed.connections[0], { apiKey: "session-secret", password: "other-secret" });
  const raw = serializeProviderSettings(source, changed);
  assert.doesNotMatch(raw, /session-secret|other-secret|defaultModel|protocol/);
  const nextDeployment = base(); nextDeployment.connections[0].defaultModel = "updated-deployment-model";
  const restored = restoreProviderSettings(nextDeployment, raw);
  assert.equal(restored.defaultProviderId, "openai");
  assert.equal(restored.connections[0].baseUrl, "https://model.example/v1");
  assert.equal(restored.connections[0].auth.envVar, "EXAMPLE_API_KEY");
  assert.equal(restored.connections[0].defaultModel, "updated-deployment-model");
  assert.equal(restored.connections[1].enabled, true);
  changed.connections[1].defaultModel = "chosen-model";
  changed.connections[1].models = ["chosen-model", "another-model"];
  assert.deepEqual(restoreProviderSettings(source, serializeProviderSettings(source, changed)).connections[1].models, ["chosen-model", "another-model"]);
});

test("disabling an added service retains its configuration and list membership across reload", () => {
  const source = base();
  let current = updateProviderSettings(source, "openai", { enabled: true, added: true });
  current = updateProviderSettings(current, "openai", { defaultModel: "my-model", enabled: false });
  const restored = restoreProviderSettings(source, serializeProviderSettings(source, current));
  assert.equal(restored.connections[1].enabled, false);
  assert.equal(providerIsAdded(restored.connections[1]), true);
  assert.equal(restored.connections[1].defaultModel, "my-model");
  assert.equal(providerIsAdded(source.connections[1]), false);
  assert.equal(source.connections[1].defaultModel, "gpt-4o", "draft updates never mutate the saved source");
  assert.equal(updateProviderSettings(restored, "openai", { enabled: true }).connections[1].defaultModel, "my-model");
});

test("old edited disabled providers remain discoverable and new added state is validated", () => {
  const restored = restoreProviderSettings(base(), JSON.stringify({version:1,connections:[{id:"openai",enabled:false,baseUrl:"https://model.example/v1"}]}));
  assert.equal(providerIsAdded(restored.connections[1]), true);
  assert.throws(() => restoreProviderSettings(base(), JSON.stringify({version:1,connections:[{id:"openai",added:"yes"}]})));
});

test("draft validation identifies the exact invalid field without resetting the user's text", () => {
  const provider = createProviderConnection("deepseek", true);
  assert.equal(providerValidationIssue(provider), undefined);
  assert.equal(providerValidationIssue({...provider,baseUrl:"https://model.example?key=secret"}), "baseUrl");
  assert.equal(providerValidationIssue({...provider,defaultModel:" "}), "defaultModel");
  assert.equal(providerValidationIssue({...provider,auth:{mode:"env",envVar:"bad key"}}), "authEnvVar");
  const changed = updateProviderSettings(base(), "deepseek", {authEnvVar:""});
  assert.equal(changed.connections[0].auth.envVar, "");
  assert.equal(providerValidationIssue(changed.connections[0]), "authEnvVar");
  const withSpaces = updateProviderSettings(base(), "deepseek", {defaultModel:" custom-model ",baseUrl:" https://model.example/v1 "});
  const saved = restoreProviderSettings(base(),serializeProviderSettings(base(),normalizeProviderSettings(withSpaces)));
  assert.equal(saved.connections[0].defaultModel, "custom-model");
  assert.equal(saved.connections[0].baseUrl, "https://model.example/v1");
  assert.equal(withSpaces.connections[0].defaultModel, " custom-model ", "validation/save normalization never mutates the draft");
});

test("invalid saved settings cannot introduce services, change protocols/authentication, or retain credential-bearing addresses", () => {
  const source = base();
  const raw = JSON.stringify({ version: 1, defaultProviderId: "unknown", connections: [
    { id: "unknown", baseUrl: "https://other.example" },
    { id: "deepseek", apiKey: "secret", protocol: "other", auth: { mode: "none" } },
  ] });
  assert.deepEqual(restoreProviderSettings(source, raw), source);
  for (const baseUrl of ["https://user:password@model.example/v1", "https://model.example/v1?api_key=secret", "https://model.example/v1#secret", "javascript:alert(1)", "not a URL"]) {
    const changed = structuredClone(source); changed.connections[0].baseUrl = baseUrl;
    assert.throws(() => serializeProviderSettings(source, changed));
    assert.throws(() => restoreProviderSettings(source, JSON.stringify({ version: 1, connections: [{ id: "deepseek", baseUrl }] })));
  }
  for (const value of ["{", "null", '{"version":2,"connections":[]}', JSON.stringify({version:1,connections:[{id:"deepseek",enabled:false}] }),
    JSON.stringify({version:1,connections:[{id:"deepseek",models:[42]}]}),
    JSON.stringify({version:1,connections:[{id:"deepseek",authEnvVar:"session-secret"}]})]) {
    assert.throws(() => restoreProviderSettings(source, value));
  }
  assert.equal(restoreProviderSettings(source, null), source);
  assert.deepEqual(JSON.parse(serializeProviderSettings(source, source)), {version:1,connections:[]});
});

test("model metadata survives draft update, normalization, save and reload for each model", () => {
  const source = base();
  const changed = updateProviderSettings(source, "deepseek", {
    defaultModel: " custom-model ", models: [" custom-model ", "text-model"],
    modelOptions: { " custom-model ": { contextWindow: 256_000, maxTokens: 32_000, reasoning: true }, "text-model": { input: ["text"] } },
  });
  assert.equal(providerValidationIssue(changed.connections[0]), undefined);
  const normalized = normalizeProviderSettings(changed);
  const restored = restoreProviderSettings(source, serializeProviderSettings(source, normalized));
  assert.deepEqual(restored.connections[0].modelOptions, {
    "custom-model": { contextWindow: 256_000, maxTokens: 32_000, reasoning: true }, "text-model": { input: ["text"] },
  });
  assert.equal(restored.connections[0].defaultModel, "custom-model");
  assert.equal(source.connections[0].modelOptions, undefined);
  assert.ok(Object.hasOwn(changed.connections[0].modelOptions!, " custom-model "), "normalization leaves the editable draft intact");
});

test("metadata validation rejects invalid saved values and clearing metadata survives reload", () => {
  const source = base();
  for (const modelOptions of [
    { "deepseek-chat": { maxTokens: 200_000 } }, { "deepseek-chat": { reasoning: "yes" } },
    { "deepseek-chat": { contextWindow: 64_000, maxTokens: 65_000 } }, { "not-configured": { input: ["text"] } },
    { "deepseek-chat": { madeUp: true } }, null,
  ]) {
    const malformed = { ...source.connections[0], modelOptions } as unknown as typeof source.connections[number];
    assert.equal(providerValidationIssue(malformed), "modelOptions");
    assert.throws(() => serializeProviderSettings(source, { ...source, connections: [malformed, source.connections[1]] }));
    assert.throws(() => restoreProviderSettings(source, JSON.stringify({ version: 1, connections: [{ id: "deepseek", modelOptions }] })));
  }
  source.connections[0].modelOptions = { "deepseek-chat": { contextWindow: 256_000 } };
  const cleared = updateProviderSettings(source, "deepseek", { modelOptions: undefined });
  assert.deepEqual(restoreProviderSettings(source, serializeProviderSettings(source, cleared)).connections[0].modelOptions, {});
  const nextDeployment = base();
  nextDeployment.connections[0].modelOptions = { "deepseek-chat": { contextWindow: 512_000 } };
  assert.deepEqual(restoreProviderSettings(nextDeployment, serializeProviderSettings(source, source)).connections[0].modelOptions,
    nextDeployment.connections[0].modelOptions, "untouched metadata continues to inherit deployment defaults");
});
