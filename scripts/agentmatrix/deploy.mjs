#!/usr/bin/env node
/**
 * Deploy RaytoneBot onto AgentMatrix (RT-01).
 *
 *   node scripts/agentmatrix/deploy.mjs plan     resolve and print, create nothing
 *   node scripts/agentmatrix/deploy.mjs deploy   publish, install, start
 *   node scripts/agentmatrix/deploy.mjs status   current environment/session/health
 *   node scripts/agentmatrix/deploy.mjs preview  print a fresh signed entry URL
 *   node scripts/agentmatrix/deploy.mjs stop     stop the app and release the machine
 *
 * Every platform resource is reused by recorded ID, so a re-run resumes instead
 * of creating a second deployment. The bot's data lives in the bound Workspace:
 * /workspace/raytonebot (code), /workspace/.raytonebot (state), /workspace/am.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readConfig, requireConfig, secretLines } from "./config.mjs";
import {
  createClient, ensureEnvironment, ensureEnvironmentSpec, ensurePreview, ensureRunning, ensureSession, ensureWorkspace,
  previewOrigin, probePreview, publishRelease, publishSecrets, readWorkspaceText, resolveAgentSpec, runBootstrapTurn,
  waitForMarker,
} from "./platform.mjs";
import { buildRelease, buildReleaseFromHead } from "./release.mjs";
import { readAccess, readState, writeAccess, writeState } from "./state.mjs";

const root = process.cwd();
const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-")) ?? "deploy";
const dryRun = command === "plan" || argv.includes("--dry-run");
const skipBuild = argv.includes("--skip-build");
const clean = argv.includes("--clean");

const log = (line) => console.log(`[am] ${line}`);

function printPlan(config, release) {
  console.log(JSON.stringify({
    command: dryRun ? "plan" : command,
    namespace: config.namespace,
    baseURL: config.baseURL,
    workspace: config.workspaceId || `${config.name} (created if absent)`,
    environmentSpec: config.environmentSpecId || `${config.name}-e2b (created if absent)`,
    agentSpec: config.agentSpecId || "discovered",
    llmCredential: config.llmCredentialId || "platform default",
    port: config.port,
    release: release ? { file: release.file, bytes: release.bytes, sha256: release.sha256, commit: release.commit } : undefined,
    modelKeys: Object.keys(config.modelEnv),
  }, null, 2));
}

async function deploy(config, state) {
  const password = readAccess(root).password ?? randomBytes(24).toString("base64url");
  writeAccess(root, { password, username: "raytonebot" });

  const release = clean
    ? await buildReleaseFromHead({ repoRoot: root, outDir: join(root, ".agentmatrix", "release"), log })
    : await buildRelease({ repoRoot: root, outDir: join(root, ".agentmatrix", "release"), skipBuild, log });
  log(`release: ${release.bytes} bytes sha256 ${release.sha256.slice(0, 16)}… (${release.commit.slice(0, 8)}${release.dirty ? " dirty" : ""})`);
  if (dryRun) {
    printPlan(config, release);
    return;
  }

  const client = createClient(config);
  const workspaceId = await ensureWorkspace(client, config, log);
  const environmentSpecId = await ensureEnvironmentSpec(client, config, log);
  const sandboxId = await ensureEnvironment(client, config, {
    environmentSpecId, workspaceId, previousId: state.sandboxId, log,
  });
  writeState(root, { ...state, namespace: config.namespace, baseURL: config.baseURL, workspaceId, environmentSpecId, sandboxId });
  await ensureRunning(client, sandboxId, log);
  const bootstrapScript = readFileSync(join(root, "scripts", "agentmatrix", "bootstrap.sh"), "utf8");
  await publishRelease(client, { volumeId: workspaceId, release, bootstrapScript, log });

  const agentSpec = await resolveAgentSpec(client, config, log);
  const sessionId = await ensureSession(client, config, { sandboxId, agentSpec, previous: state, log });
  writeState(root, { ...readState(root), sessionId });
  const preview = await ensurePreview(client, sessionId, config.port, log);
  const origin = previewOrigin(preview);
  await publishSecrets(client, { volumeId: workspaceId, lines: secretLines(config, password), log });

  log(`turn 1/1: install (if needed) and start on ${origin}`);
  const output = await runBootstrapTurn(client, sessionId, `bash /workspace/am/bootstrap.sh deploy ${origin}`, {
    log, timeoutMs: 14 * 60_000,
  });
  const failed = (await Promise.all(["am/install.failed", "am/start.failed"].map((path) =>
    readWorkspaceText(client, workspaceId, path).catch(() => "")))).filter(Boolean).join("\n");
  if (failed.trim()) throw new Error(`deployment failed inside the Environment:\n${failed.trim()}`);
  try {
    await waitForMarker(client, workspaceId, {
      ok: "am/listening.ok", failed: "am/start.failed", match: origin, timeoutMs: 90_000, describe: "start", log,
      wake: () => ensureRunning(client, sandboxId, log),
    });
  } catch (error) {
    throw new Error(`${error.message}\nagent output:\n${output.slice(-1200)}`);
  }

  const probe = await probePreview(preview, password);
  writeState(root, {
    namespace: config.namespace,
    baseURL: config.baseURL,
    workspaceId,
    environmentSpecId,
    sandboxId,
    sessionId,
    previewId: preview.preview_id,
    publicOrigin: origin,
    entryUrl: preview.url,
    entryUrlExpiresAt: preview.url_expires_at,
    release,
    probe,
    deployedAt: new Date().toISOString(),
  });

  log("deployed");
  console.log("");
  console.log(`  entry:    ${preview.url}`);
  console.log(`  origin:   ${origin}`);
  console.log(`  login:    raytonebot / ${password}`);
  console.log(`  state:    .agentmatrix/deployment.json (access: .agentmatrix/access.json)`);
  console.log(`  probe:    signed URL answered ${probe.status}${probe.location ? ` -> ${probe.location}` : ""}`);
}

async function status(config) {
  const state = readState(root);
  if (!state.sandboxId) {
    console.log("no AgentMatrix deployment recorded; run `node scripts/agentmatrix/deploy.mjs deploy`");
    return;
  }
  const client = createClient(config);
  const password = readAccess(root).password;
  const rows = {};
  for (const [key, call] of Object.entries({
    environment: () => client.sandboxes.get(state.sandboxId).then((r) => r.data),
    session: () => client.sessions.get(state.sessionId).then((r) => r.data),
    preview: () => client.sessions.resources.preview.get(state.sessionId, state.previewId).then((r) => r.data),
    install: () => readWorkspaceText(client, state.workspaceId, "am/install.ok"),
    listening: () => readWorkspaceText(client, state.workspaceId, "am/listening.ok"),
  })) {
    try {
      rows[key] = await call();
    } catch (error) {
      rows[key] = { error: error.message, status: error.status };
    }
  }
  console.log(JSON.stringify({ ...rows, entry: rows.preview?.url, password: password ? "(stored locally)" : "(missing)" }, null, 2));
  if (rows.preview?.url) {
    const probe = await probePreview(rows.preview, password);
    console.log(`probe: ${probe.status}${probe.location ? ` -> ${probe.location}` : ""}${probe.error ? ` ${probe.error}` : ""}`);
  }
}

async function preview(config) {
  const state = readState(root);
  if (!state.sessionId) throw new Error("no deployment recorded");
  const client = createClient(config);
  const fresh = await ensurePreview(client, state.sessionId, config.port, log);
  const origin = previewOrigin(fresh);
  writeState(root, { ...state, previewId: fresh.preview_id, publicOrigin: origin, entryUrl: fresh.url, entryUrlExpiresAt: fresh.url_expires_at });
  console.log(fresh.url);
  if (origin !== state.publicOrigin) {
    console.log(`origin changed (${state.publicOrigin} -> ${origin}); run deploy again to restart the app with the new origin`);
  }
}

async function wake(config) {
  const state = readState(root);
  if (!state.sandboxId) throw new Error("no deployment recorded");
  const client = createClient(config);
  await ensureRunning(client, state.sandboxId, log);
  const fresh = await ensurePreview(client, state.sessionId, config.port, log);
  writeState(root, { ...readState(root), publicOrigin: previewOrigin(fresh), entryUrl: fresh.url, entryUrlExpiresAt: fresh.url_expires_at });
  console.log(fresh.url);
}

async function stop(config) {
  const state = readState(root);
  if (!state.sessionId) throw new Error("no deployment recorded");
  const client = createClient(config);
  try {
    await runBootstrapTurn(client, state.sessionId, "bash /workspace/am/bootstrap.sh stop", { log, timeoutMs: 120_000 });
  } catch (error) {
    log(`stop command failed (continuing): ${error.message}`);
  }
  await client.sessions.archive(state.sessionId, { reason: "raytonebot am stop" }).catch((error) => log(`archive: ${error.message}`));
  if (state.sandboxId) await client.sandboxes.delete(state.sandboxId).catch((error) => log(`delete: ${error.message}`));
  writeState(root, { ...state, sandboxId: undefined, sessionId: undefined, previewId: undefined, stoppedAt: new Date().toISOString() });
  log("stopped; the Workspace and its files are retained");
}

const config = readConfig();
if (command === "plan") {
  printPlan(config, undefined);
} else {
  requireConfig(config);
  if (command === "deploy") await deploy(config, readState(root));
  else if (command === "status") await status(config);
  else if (command === "preview") await preview(config);
  else if (command === "wake") await wake(config);
  else if (command === "stop") await stop(config);
  else throw new Error(`unknown command ${command}`);
}
