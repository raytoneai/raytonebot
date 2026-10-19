import assert from "node:assert/strict";
import { test } from "node:test";

import { AM, missingConfig, readConfig, secretLines } from "./config.mjs";

test("readConfig applies AgentMatrix defaults and keeps secrets out of state", () => {
  const config = readConfig({ ARIADRA_API_KEY: "ariadra_test", DEEPSEEK_API_KEY: "sk-1" });
  assert.equal(config.baseURL, AM.baseURL);
  assert.equal(config.namespace, "default");
  assert.equal(config.port, 5188);
  assert.deepEqual(config.modelEnv, { DEEPSEEK_API_KEY: "sk-1" });
  assert.equal(config.workspaceId, "");
});

test("readConfig honours explicit resource IDs and the region", () => {
  const config = readConfig({
    ARIADRA_API_KEY: "k", ARIADRA_NAMESPACE: "prod", AGENTMATRIX_WORKSPACE_ID: "vol_1",
    AGENTMATRIX_ENVIRONMENT_SPEC_ID: "env_1", AGENTMATRIX_AGENT_SPEC_ID: "asp_1",
    AGENTMATRIX_AGENT_SPEC_VERSION: "3", AGENTMATRIX_PORT: "8080", AGENTMATRIX_REGION: "us-east-1",
  });
  assert.equal(config.namespace, "prod");
  assert.equal(config.workspaceId, "vol_1");
  assert.equal(config.environmentSpecId, "env_1");
  assert.equal(config.agentSpecId, "asp_1");
  assert.equal(config.agentSpecVersion, 3);
  assert.equal(config.port, 8080);
  assert.equal(config.region, "us-east-1");
});

test("a missing key is reported before any platform call", () => {
  assert.deepEqual(missingConfig(readConfig({})), ["ARIADRA_API_KEY"]);
  assert.deepEqual(missingConfig(readConfig({ ARIADRA_API_KEY: "k", AGENTMATRIX_PORT: "0" })), ["AGENTMATRIX_PORT"]);
});

test("secretLines writes the password first and rejects shell-hostile values", () => {
  const config = readConfig({ ARIADRA_API_KEY: "k", DEEPSEEK_API_KEY: "sk-abc" });
  assert.deepEqual(secretLines(config, "p".repeat(32)), ["RAYTONEBOT_PASSWORD=" + "p".repeat(32), "DEEPSEEK_API_KEY=sk-abc"]);
  const unsafe = readConfig({ ARIADRA_API_KEY: "k", DEEPSEEK_API_KEY: "sk abc" });
  assert.throws(() => secretLines(unsafe, "p".repeat(32)), /cannot be written/);
});
