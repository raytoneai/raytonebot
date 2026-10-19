/**
 * Configuration for the AgentMatrix hosting adapter (RT-01).
 *
 * Everything that names a tenant resource is optional: the adapter discovers or
 * creates the Workspace, EnvironmentSpec and Session, and only pins them when the
 * caller supplies an ID. Secrets are read from the process environment and never
 * written back to the repository; `.agentmatrix/` (gitignored) holds the resolved
 * non-secret state plus the generated access password.
 */

import { join } from "node:path";

export const AM = {
  baseURL: "https://api.agentmatrix.pro",
  namespace: "default",
  name: "raytonebot",
  port: 5188,
  region: "",
  workspaceName: "raytonebot",
  environmentSpecName: "raytonebot-e2b",
  agentSpecName: "raytonebot-bootstrap",
  /** Volume attachments are capped at 20 MiB by the platform contract. */
  maxAttachmentBytes: 20 * 1024 * 1024,
  /** Only what the app actually needs outbound; the platform adapter channel is added by AM itself. */
  outboundAllow: ["api.deepseek.com", "registry.npmjs.org"],
  /** Keys copied from the operator's shell into the bot's private env file. */
  modelKeys: ["DEEPSEEK_API_KEY", "TAVILY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
};

const text = (value) => (typeof value === "string" ? value.trim() : "");
const integer = (value, fallback) => {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function readConfig(env = process.env) {
  return {
    apiKey: text(env.ARIADRA_API_KEY),
    baseURL: text(env.ARIADRA_BASE_URL) || AM.baseURL,
    namespace: text(env.ARIADRA_NAMESPACE) || AM.namespace,
    name: text(env.AGENTMATRIX_NAME) || AM.name,
    port: integer(env.AGENTMATRIX_PORT, AM.port),
    region: text(env.AGENTMATRIX_REGION) || AM.region,
    workspaceId: text(env.AGENTMATRIX_WORKSPACE_ID),
    sandboxId: text(env.AGENTMATRIX_SANDBOX_ID),
    environmentSpecId: text(env.AGENTMATRIX_ENVIRONMENT_SPEC_ID),
    agentSpecId: text(env.AGENTMATRIX_AGENT_SPEC_ID),
    agentSpecVersion: integer(env.AGENTMATRIX_AGENT_SPEC_VERSION, undefined),
    llmCredentialId: text(env.AGENTMATRIX_LLM_CREDENTIAL_ID),
    /** Provider API keys handed to the bot, not to the agent's shell. */
    modelEnv: Object.fromEntries(AM.modelKeys.flatMap((key) => (text(env[key]) ? [[key, text(env[key])]] : []))),
  };
}

/** Names of required settings that are still empty, in the order to fix them. */
export function missingConfig(config) {
  const missing = [];
  if (!config.apiKey) missing.push("ARIADRA_API_KEY");
  if (!config.namespace) missing.push("ARIADRA_NAMESPACE");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) missing.push("AGENTMATRIX_PORT");
  return missing;
}

export function requireConfig(config) {
  const missing = missingConfig(config);
  if (missing.length) {
    throw new Error(`Missing AgentMatrix settings: ${missing.join(", ")}. ` +
      "Issue a data-plane key in the Console (API Keys) and export it before deploying.");
  }
  return config;
}

/** Secret lines for the bot's private env file. Values must survive a shell `KEY=value` line. */
export function secretLines(config, password) {
  const lines = [`RAYTONEBOT_PASSWORD=${password}`];
  for (const [key, value] of Object.entries(config.modelEnv)) {
    if (!/^[A-Za-z0-9._:/@+-]+$/.test(value)) {
      throw new Error(`${key} contains characters that cannot be written to a shell env file`);
    }
    lines.push(`${key}=${value}`);
  }
  return lines;
}

export const accessFile = (root) => join(root, ".agentmatrix", "access.json");
export const stateFile = (root) => join(root, ".agentmatrix", "deployment.json");
export const releaseDir = (root) => join(root, ".agentmatrix", "release");
