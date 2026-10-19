/**
 * Platform operations for the AgentMatrix hosting adapter (RT-01).
 *
 * Only the public Platform contract (SDK 0.11.0 / OpenAPI 0.155.0) is used:
 * Workspaces, EnvironmentSpecs, Environments (the wire still says sandbox),
 * Sessions, Session resources and previews. There is no exec API, so the
 * in-Environment work is one fixed command run by a managed Session's shell.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { AgentMatrix, INITIAL_REPLY_CONTEXT, deriveReplyContext } from "@agentmatrix.pro/sdk";

import { AM } from "./config.mjs";

export const CHUNK_BYTES = 1024 * 1024;

export function createClient(config) {
  return new AgentMatrix({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    namespace: config.namespace,
    maxRetries: 2,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const transient = (error) => error?.status === undefined || error?.status === 408 || error?.status === 429 || error?.status >= 500;

/** The local proxy occasionally drops a connect; writes are small and safe to re-issue. */
export async function withRetry(action, { attempts = 4, log = () => {}, label = "request" } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !transient(error)) throw error;
      log(`${label}: ${error.code ?? error.message}; retrying (${attempt}/${attempts})`);
      await sleep(attempt * 1_500);
    }
  }
}

/** Follows `next_page` while the envelope says `has_more`. */
export async function listAll(list, query = {}) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const envelope = await list({ ...query, ...(cursor ? { cursor } : {}) });
    rows.push(...envelope.data);
    if (!envelope.has_more || !envelope.next_page) break;
    cursor = envelope.next_page;
  }
  return rows;
}

// ---------------------------------------------------------------- Workspace

export async function ensureWorkspace(client, config, log = () => {}) {
  if (config.workspaceId) {
    log(`workspace: pinned ${config.workspaceId}`);
    return config.workspaceId;
  }
  const workspaces = await listAll((query) => client.workspaces.list(query));
  const existing = workspaces.find((row) => row.name === AM.workspaceName);
  if (existing) {
    log(`workspace: reusing ${existing.volume_id}`);
    return existing.volume_id;
  }
  const created = await client.workspaces.create({ name: AM.workspaceName });
  log(`workspace: created ${created.volume_id}`);
  return created.volume_id;
}

/**
 * Publishes the fixed bootstrap script and the release chunks into the Workspace.
 * The file API caps one file at 1 MiB, so the archive travels as numbered parts
 * that `bootstrap.sh install` concatenates and checks against the SHA-256.
 */
export async function publishRelease(client, { volumeId, release, bootstrapScript, log = () => {} }) {
  const bytes = readFileSync(release.file);
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  // One directory per release digest: a shorter new release can never be
  // corrupted by parts left over from an earlier one.
  const directory = `am/release/${release.sha256.slice(0, 12)}`;
  await client.workspaces.entries.mkdir(volumeId, "am").catch(() => {});
  await client.workspaces.entries.mkdir(volumeId, "am/release").catch(() => {});
  await client.workspaces.entries.mkdir(volumeId, directory).catch(() => {});
  for (let index = 0; index < parts; index += 1) {
    const slice = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const name = `${directory}/part-${String(index).padStart(3, "0")}`;
    await withRetry(() => client.workspaces.files.write(volumeId, name, new Uint8Array(slice)),
      { log, label: `upload ${index + 1}/${parts}` });
  }
  const write = (path, body) => withRetry(() => client.workspaces.files.writeText(volumeId, path, body), { log, label: path });
  await write("am/release-parts", String(parts));
  await write("am/release.dir", directory);
  await write("am/release.sha256", release.sha256);
  await write("am/bootstrap.sh", bootstrapScript);
  log(`workspace: published ${parts} release part(s) (${release.bytes} bytes, sha256 ${release.sha256.slice(0, 12)}…)`);
}

export async function publishSecrets(client, { volumeId, lines, log = () => {} }) {
  await client.workspaces.files.writeText(volumeId, "am/secrets.env", `${lines.join("\n")}\n`);
  log("workspace: wrote am/secrets.env (moved into the bot's private env file on start)");
}

export async function readWorkspaceText(client, volumeId, path) {
  const response = await client.workspaces.files.read(volumeId, path);
  return response.text();
}

/**
 * Waits for one of the markers the detached bootstrap writes. The agent's shell
 * only starts the work, so the deployment never depends on the model's timeout.
 */
export async function waitForMarker(client, volumeId, { ok, failed, match, timeoutMs, describe, log = () => {}, wake }) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = Date.now();
  let lastWake = 0;
  const read = async (path) => {
    try {
      return { text: (await readWorkspaceText(client, volumeId, path)).trim() };
    } catch (error) {
      return { text: "", error };
    }
  };
  while (Date.now() < deadline) {
    const okResult = await read(ok);
    if (okResult.text && (!match || okResult.text.includes(match))) return okResult.text;
    const failedResult = await read(failed);
    if (failedResult.text) throw new Error(`${describe} failed inside the Environment:\n${failedResult.text}`);

    // An idle-paused Environment detaches its Workspace, so reads answer 503 until
    // it is resumed. Cheap GETs are harmless while it is already running.
    const unavailable = [okResult.error, failedResult.error].some((error) => error && error.status !== 404);
    if (unavailable && wake && Date.now() - lastWake > 15_000) {
      lastWake = Date.now();
      log(`${describe}: Workspace unavailable; resuming the Environment`);
      await wake().catch((error) => log(`${describe}: resume failed: ${error.code ?? error.message}`));
    }
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      log(`${describe}: still running…`);
    }
    await sleep(5_000);
  }
  throw new Error(`${describe} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);
}

// ----------------------------------------------------------- EnvironmentSpec

const domainRule = (domain) => (domain.startsWith("*.") ? { type: "wildcard_domain", domain } : { type: "domain", domain });

/**
 * `outboundAllowlist` is false when the selected provider cannot enforce an
 * allowlist (capabilities.network.outbound_allowlist). Such a provider only
 * offers open or no egress, so the adapter records the weaker policy instead of
 * silently claiming a narrow one.
 */
export function networkPolicy(port = AM.port, { outboundAllowlist = true } = {}) {
  return {
    outbound: outboundAllowlist
      ? { default: "deny", allow: AM.outboundAllow.map(domainRule) }
      : { default: "allow", allow: [] },
    public_access: { default: "deny", allow: [{ type: "port", protocol: "http", port }] },
  };
}

/** The provider-specific EnvironmentSpec body; container sandboxes nest the provider id. */
export function runtimeConfig(provider) {
  const id = provider.sandbox_provider_id;
  return provider.runtime_kind === "container_sandbox"
    ? { kind: "container", container: { sandbox_provider_id: id } }
    : { sandbox_provider_id: id };
}

export async function ensureEnvironmentSpec(client, config, log = () => {}) {
  if (config.environmentSpecId) {
    log(`environment spec: pinned ${config.environmentSpecId}`);
    return config.environmentSpecId;
  }
  const specs = await listAll((query) => client.environmentSpecs.list(query));
  const existing = specs.find((row) => row.name === AM.environmentSpecName && !row.archived_at);
  if (existing) {
    const allowsPort = (existing.network_policy?.public_access?.allow ?? [])
      .some((rule) => rule.type === "port" && rule.port === config.port);
    if (!allowsPort) {
      await client.environmentSpecs.update(existing.environment_spec_id, { network_policy: networkPolicy(config.port) });
      log(`environment spec: updated ${existing.environment_spec_id} to allow port ${config.port}`);
    } else {
      log(`environment spec: reusing ${existing.environment_spec_id}`);
    }
    return existing.environment_spec_id;
  }

  const providers = await client.sandboxProviders.list();
  const provider = providers.data.find((row) => row.selectable && row.runtime_kind === "e2b_sandbox") ??
    providers.data.find((row) => row.selectable);
  if (!provider) throw new Error("no selectable sandbox provider in this namespace; ask AM for a provider profile");
  const outboundAllowlist = provider.capabilities?.network?.outbound_allowlist !== false;
  if (!outboundAllowlist) {
    log("environment spec: provider cannot enforce an outbound allowlist; open egress is recorded as a known gap");
  }

  const created = await client.environmentSpecs.create({
    name: AM.environmentSpecName,
    description: "RaytoneBot host: Node HTTP app on 5188, preview allowed, narrow egress when the provider supports it.",
    runtime_kind: provider.runtime_kind,
    runtime_config: runtimeConfig(provider),
    ...(config.region ? { region: config.region } : {}),
    network_policy: networkPolicy(config.port, { outboundAllowlist }),
    default_env: { NODE_ENV: "production" },
  });
  log(`environment spec: created ${created.data.environment_spec_id} on ${provider.display_name}`);
  return created.data.environment_spec_id;
}

// --------------------------------------------------------------- Environment

async function waitOperation(client, sandboxId, operation, log) {
  let current = operation;
  const deadline = Date.now() + 10 * 60_000;
  while (current.state !== "completed") {
    if (Date.now() > deadline) throw new Error(`sandbox ${current.type} did not finish within 10 minutes`);
    await sleep(Math.max(2000, (current.retry_after_seconds ?? 2) * 1000));
    current = (await client.sandboxes.operation(sandboxId, operation.operation_id)).data;
    log?.(`environment: ${current.type} ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
  }
  if (current.outcome !== "succeeded") {
    throw new Error(`sandbox ${current.type} ended ${current.outcome ?? "unknown"}${current.reason ? `: ${current.reason}` : ""}`);
  }
  return current;
}

/**
 * A paused Environment resumes before any work; pausing/resuming is a settled
 * state machine, so an in-flight transition is waited out rather than replayed.
 */
export async function ensureRunning(client, sandboxId, log = () => {}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { data } = await client.sandboxes.get(sandboxId);
    if (data.state === "running") return sandboxId;
    if (data.state === "paused") {
      try {
        const resumed = await client.sandboxes.resume(sandboxId, {
          idempotencyKey: `raytonebot-resume-${randomBytes(12).toString("hex")}`,
        });
        await waitOperation(client, sandboxId, resumed.data.operation, log);
        log(`environment: resumed ${sandboxId}`);
        return sandboxId;
      } catch (error) {
        log(`environment: resume not accepted yet (${error.code ?? error.message}); retrying`);
      }
    } else if (!["pausing", "resuming", "creating", "pending"].includes(data.state)) {
      throw new Error(`environment ${sandboxId} is ${data.state}; it cannot run the app`);
    }
    await sleep(3_000);
  }
  throw new Error(`environment ${sandboxId} did not reach running`);
}

export async function ensureEnvironment(client, config, { environmentSpecId, workspaceId, previousId, log = () => {} }) {
  const candidates = [config.sandboxId, previousId].filter(Boolean);
  for (const id of candidates) {
    try {
      const { data } = await client.sandboxes.get(id);
      if (data.state !== "deleted") {
        log(`environment: reusing ${data.sandbox_id} (${data.state})`);
        return data.sandbox_id;
      }
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  if (config.sandboxId || previousId) {
    log("environment: recorded instance is gone; creating a replacement bound to the same Workspace");
  } else {
    // A previous run can fail before its state is written. Adopt the instance it
    // created instead of taking a second (quota-limited) Environment slot.
    const page = await client.sandboxes.list({ limit: 20 });
    const adopted = page.data.find((row) => row.state !== "deleted" &&
      (!row.environment_spec_id || row.environment_spec_id === environmentSpecId) &&
      (!row.workspace_id || row.workspace_id === workspaceId));
    if (adopted) {
      log(`environment: adopted unattached ${adopted.sandbox_id} (${adopted.state})`);
      return adopted.sandbox_id;
    }
  }
  const created = await client.sandboxes.create(
    { environment_spec_id: environmentSpecId, workspace_id: workspaceId },
    { idempotencyKey: `raytonebot-env-${randomBytes(12).toString("hex")}` },
  );
  await waitOperation(client, created.data.sandbox.sandbox_id, created.data.operation, log);
  log(`environment: created ${created.data.sandbox.sandbox_id}`);
  return created.data.sandbox.sandbox_id;
}

// -------------------------------------------------------------------- Session

export async function resolveAgentSpec(client, config, log = () => {}) {
  const specs = await listAll((query) => client.agentSpecs.list(query));
  const chosen = config.agentSpecId
    ? specs.find((row) => row.agent_spec_id === config.agentSpecId)
    : specs.find((row) => row.name === AM.agentSpecName) ?? (specs.length === 1 ? specs[0] : undefined);
  if (!chosen) {
    throw new Error(config.agentSpecId
      ? `AgentSpec ${config.agentSpecId} not found in namespace ${config.namespace}`
      : `no AgentSpec to run the bootstrap. Create one named "${AM.agentSpecName}" (claude_code, bypassPermissions, allowed_tools empty) ` +
        "and set AGENTMATRIX_AGENT_SPEC_ID.");
  }
  const version = config.agentSpecVersion ?? chosen.latest_version;
  const { data } = await client.agentSpecs.versions.get(chosen.agent_spec_id, version);
  const mode = data.tool_permission_mode;
  const bypass = data.runtime_driver === "codex_cli" ? mode === "never" : mode === "bypassPermissions";
  if (!bypass) {
    throw new Error(`AgentSpec ${chosen.agent_spec_id} v${version} uses ${mode}; the bootstrap needs ` +
      `${data.runtime_driver === "codex_cli" ? "never" : "bypassPermissions"} so the fixed command runs without an approval`);
  }
  log(`agent spec: ${chosen.name} v${version} (${data.runtime_driver}, ${mode})`);
  return { agentSpecId: chosen.agent_spec_id, version };
}

export async function ensureSession(client, config, { sandboxId, agentSpec, previous, log = () => {} }) {
  if (previous?.sessionId) {
    try {
      const { data } = await client.sessions.get(previous.sessionId);
      if (data.current_status !== "terminated") {
        log(`session: reusing ${data.session_id} (${data.current_status})`);
        return data.session_id;
      }
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  const page = await client.sessions.list({ limit: 100, archived: "all" });
  const adopted = page.data
    .filter((row) => row.sandbox_id === sandboxId && row.current_status !== "terminated")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (adopted) {
    log(`session: adopted ${adopted.session_id} (${adopted.current_status})`);
    return adopted.session_id;
  }
  const created = await client.sessions.create({
    agent_spec_id: agentSpec.agentSpecId,
    agent_spec_version: agentSpec.version,
    sandbox_id: sandboxId,
    ...(config.llmCredentialId ? { llm_provider_credential_id: config.llmCredentialId } : {}),
  });
  log(`session: created ${created.data.session_id}`);
  return created.data.session_id;
}

// --------------------------------------------------------------- Conversation

export async function replyContext(client, sessionId) {
  const page = await client.sessions.events.listLatest(sessionId, { limit: 200 });
  return deriveReplyContext(page.data) ?? INITIAL_REPLY_CONTEXT;
}

export function lastAgentText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "agent.message") {
      const blocks = event.payload?.content ?? [];
      return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    }
  }
  return "";
}

/**
 * Submits one fixed command and streams the turn to completion. The prompt is
 * constant per step; the model chooses nothing.
 */
export async function runBootstrapTurn(client, sessionId, command, { log = () => {}, timeoutMs = 15 * 60_000 } = {}) {
  const message = [
    "Run exactly this command with your shell tool and then report its output verbatim.",
    "Set the shell tool's timeout to 600000 ms: it installs Node dependencies and can take several minutes.",
    "",
    `    ${command}`,
    "",
    "Do not edit files, do not run anything else, and stop as soon as the command exits.",
  ].join("\n");
  const context = await replyContext(client, sessionId);
  const deadline = Date.now() + timeoutMs;
  let text = "";
  for await (const update of client.sessions.runTurn(sessionId, message, {
    replyContext: context,
    idleTimeoutMs: 60_000,
    reconnect: { maxAttempts: 20, maxDelayMs: 5_000 },
    streamStopSignal: AbortSignal.timeout(timeoutMs),
  })) {
    if (update.type === "event") {
      const event = update.event;
      if (event.type === "agent.message") {
        text = lastAgentText([event]) || text;
      } else if (event.type === "agent.tool_use") {
        log(`  tool: ${event.payload?.tool_name ?? "tool"}`);
      } else if (event.type === "session.error") {
        log(`  session error: ${JSON.stringify(event.payload?.error ?? {}).slice(0, 300)}`);
      }
    } else if (update.type === "result") {
      const turn = update.result.turn;
      if (turn.type !== "end_turn") {
        throw new Error(`bootstrap turn ended ${turn.type}${turn.stopReason ? ` (${turn.stopReason})` : ""}`);
      }
      return text;
    }
    if (Date.now() > deadline) throw new Error("bootstrap turn exceeded its time budget");
  }
  return text;
}

// ------------------------------------------------------------------- Previews

export async function ensurePreview(client, sessionId, port = AM.port, log = () => {}) {
  const list = await client.sessions.resources.preview.list(sessionId);
  const active = list.data.find((row) => row.status === "active" && row.port === port);
  const { data } = active
    ? await client.sessions.resources.preview.get(sessionId, active.preview_id)
    : await client.sessions.resources.preview.create(sessionId, { port, label: "raytonebot" });
  log(`preview: ${data.preview_id} ${data.url_expires_at ? `expires ${data.url_expires_at}` : ""}`);
  return data;
}

export function previewOrigin(preview) {
  return new URL(preview.url).origin;
}

/** Best-effort check of the human entry: the signed URL redirects to the app origin. */
export async function probePreview(preview, password) {
  const authorization = `Basic ${Buffer.from(`raytonebot:${password}`).toString("base64")}`;
  try {
    const first = await fetch(preview.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return { status: first.status, location: first.headers.get("location") ?? undefined, authorization };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
