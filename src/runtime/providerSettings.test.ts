import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderConnection } from "../schema/agentuxConfig.ts";
import { restoreProviderSettings, serializeProviderSettings } from "./providerSettings.ts";

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
