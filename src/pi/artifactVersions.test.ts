import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { isVersionedArtifactId } from "../runtime/artifactVersions.ts";
import { artifactVersionsResponse } from "./artifactCatalog.ts";
import { createConversationStore } from "./conversationStore.ts";
import { ARTIFACT_VERSION_MAX_TOTAL_BYTES, ArtifactVersionError, ArtifactVersionStore, type ArtifactVersionSaveInput } from "./artifactVersions.ts";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { artifactTools } from "./artifactTool.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";

async function listen(host: ReturnType<typeof createPiHttpHost>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi` };
}

async function close(server: Server, host: ReturnType<typeof createPiHttpHost>) {
  host.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function saveInput(versionId: string, conversationId = "quota"): ArtifactVersionSaveInput {
  const sourceArtifactId = `published_version_${versionId}`;
  return { conversationId, sourceConversationId: conversationId, artifactId: JSON.stringify(["run", "artifactId", sourceArtifactId]),
    sourceArtifactId, eventArtifactId: sourceArtifactId, runId: "run", sourceRunId: "run", scope: "assistant", path: "report.md", agent: "assistant",
    name: "report.md", title: "report.md", mimeType: "text/markdown", bytes: Buffer.from("snapshot"), versionId };
}

class BlockingArtifactVersionStore extends ArtifactVersionStore {
  private readonly onEntered: () => void;
  private readonly saveWait: Promise<void>;
  constructor(root: string, entered: () => void, wait: Promise<void>) { super(root); this.onEntered = entered; this.saveWait = wait; }
  override async save(input: ArtifactVersionSaveInput): ReturnType<ArtifactVersionStore["save"]> {
    this.onEntered();
    await this.saveWait;
    return super.save(input);
  }
}

test("preserved deliveries keep A/B bytes through source deletion and restart, then delete with the conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-versions-http-"));
  const fileName = "报告 final.md";
  const cwd = join(root, "workspace"), dataDir = join(root, "data"), file = join(cwd, fileName);
  mkdirSync(cwd); writeFileSync(file, "A");
  const bridgeFactory: PiBridgeFactory = async ({ hostTools }) => ({
    subscribe: () => () => {},
    async prompt() {
      const result = await hostTools?.run("publish_artifact", { path: fileName, preserveVersion: true });
      if (!result || result.isError) throw new Error(result?.text ?? "publish_artifact was not available");
    },
    abort: async () => {}, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
  });
  let host = createPiHttpHost({ cwd, dataDir, browser: false, routineClock: false, bridgeFactory });
  let server: Server | undefined;
  try {
    ({ server } = await listen(host));
    let base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
    await host.controller.runPrompt({ conversationId: "deliveries", requestId: "run-a", prompt: "Deliver A", agentPreset: "assistant" }, () => {});
    writeFileSync(file, "B");
    await host.controller.runPrompt({ conversationId: "deliveries", requestId: "run-b", prompt: "Deliver B", agentPreset: "assistant" }, () => {});
    const catalog = await (await fetch(`${base}/artifacts?conversationId=deliveries`)).json() as { artifacts: { artifactId: string; available: boolean }[] };
    assert.equal(catalog.artifacts.length, 2, "versioned entries are not path-deduplicated");
    assert.ok(catalog.artifacts.every(entry => entry.available));
    const identities = catalog.artifacts.map(entry => entry.artifactId);
    const selected = new Map<string, string>();
    for (const artifactId of identities) {
      const response = await fetch(`${base}/artifacts/versions?conversationId=deliveries&artifactId=${encodeURIComponent(artifactId)}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { versions: { versionId: string; artifactId: string }[]; selectedVersionId: string; source: { scope: string; path: string } };
      assert.equal(body.versions.length, 2);
      assert.equal(body.versions.find(version => version.versionId === body.selectedVersionId)?.artifactId, artifactId);
      assert.deepEqual(body.source, { scope: "assistant", path: fileName });
      selected.set(artifactId, body.selectedVersionId);
    }
    const beforeRestart = await Promise.all(identities.map(async artifactId => {
      const response = await fetch(`${base}/files/download?conversationId=deliveries&artifactId=${encodeURIComponent(artifactId)}&versionId=${selected.get(artifactId)}`);
      return { artifactId, body: await response.text() };
    }));
    assert.deepEqual(new Set(beforeRestart.map(item => item.body)), new Set(["A", "B"]));
    const selectedArtifactId = beforeRestart.find(item => item.body === "A")!.artifactId;
    const selectedVersionId = selected.get(selectedArtifactId)!;
    const versionUrl = `${base}/files/download?conversationId=deliveries&artifactId=${encodeURIComponent(selectedArtifactId)}&versionId=${selectedVersionId}`;
    const head = await fetch(versionUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1");
    const range = await fetch(versionUrl, { headers: { range: "bytes=0-0" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "A");
    assert.match(range.headers.get("content-range") ?? "", /^bytes 0-0\/1$/);
    const forgedVersion = await fetch(`${base}/files/download?conversationId=deliveries&artifactId=${encodeURIComponent(selectedArtifactId)}&versionId=00000000-0000-4000-8000-000000000000`);
    assert.equal(forgedVersion.status, 404);
    const wrongConversation = await fetch(`${base}/files/download?conversationId=other&artifactId=${encodeURIComponent(selectedArtifactId)}&versionId=${selectedVersionId}`);
    assert.equal(wrongConversation.status, 404);
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside");
    unlinkSync(file); symlinkSync(outside, file);
    await close(server, host); server = undefined;

    host = createPiHttpHost({ cwd, dataDir, browser: false, routineClock: false, bridgeFactory });
    ({ server } = await listen(host));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
    const afterRestart = await (await fetch(`${base}/artifacts?conversationId=deliveries`)).json() as { artifacts: { artifactId: string; available: boolean }[] };
    assert.deepEqual(afterRestart.artifacts.map(entry => entry.artifactId).sort(), identities.slice().sort());
    assert.ok(afterRestart.artifacts.every(entry => entry.available));
    const afterBytes = await Promise.all(identities.map(async artifactId => {
      const response = await fetch(`${base}/artifacts/versions?conversationId=deliveries&artifactId=${encodeURIComponent(artifactId)}`);
      const body = await response.json() as { selectedVersionId: string };
      return (await fetch(`${base}/files/download?conversationId=deliveries&artifactId=${encodeURIComponent(artifactId)}&versionId=${body.selectedVersionId}`)).text();
    }));
    assert.deepEqual(new Set(afterBytes), new Set(["A", "B"]));
    assert.equal((await fetch(`${base}/conversations/deliveries`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/artifacts/versions?conversationId=deliveries&artifactId=${encodeURIComponent(identities[0])}`)).status, 404);
  } finally {
    if (server) await close(server, host); else host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserveVersion rejects unsupported formats, oversized files and aborted captures before publishing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-boundary-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root }); ensureWorkspaceLayout(layout);
  const published: unknown[] = [];
  const tools = artifactTools(layout, "assistant", [], (artifact, capture) => { published.push({ artifact, capture }); });
  try {
    writeFileSync(join(layout.agents.assistant, "page.html"), "<p>html</p>");
    assert.equal((await tools.run("publish_artifact", { path: "page.html", preserveVersion: true })).isError, true);
    writeFileSync(join(layout.agents.assistant, "large.md"), Buffer.alloc(20 * 1024 * 1024 + 1, 65));
    assert.equal((await tools.run("publish_artifact", { path: "large.md", preserveVersion: true })).isError, true);
    writeFileSync(join(layout.agents.assistant, "cancelled.md"), "cancelled");
    const signal = new AbortController(); signal.abort();
    assert.equal((await tools.run("publish_artifact", { path: "cancelled.md", preserveVersion: true }, signal.signal)).isError, true);
    assert.equal(published.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("group versions keep same-preset Bots on their exact projected identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-group-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root }); ensureWorkspaceLayout(layout);
  const dataDir = join(root, "data"), store = createConversationStore(dataDir);
  const versions = new ArtifactVersionStore(join(dataDir, "versions"));
  const groupId = "group";
  const bots = [
    { id: "bot_11111111-1111-4111-8111-111111111111", versionId: "11111111-1111-4111-8111-111111111111" },
    { id: "bot_22222222-2222-4222-8222-222222222222", versionId: "22222222-2222-4222-8222-222222222222" },
  ] as const;
  const path = join(layout.agents.builder, "report.md");
  writeFileSync(path, "live");
  store.begin(groupId, "assistant", "Group");
  store.setExtra(groupId, { group: { members: bots.map(bot => bot.id), hostId: bots[0].id,
    participants: bots.map(bot => ({ id: bot.id, name: bot.id, presetId: "builder" })) } });
  try {
    for (const bot of bots) {
      const nativeId = `published_version_${bot.versionId}`;
      const adapter = createPiEventAdapter({ runId: "group-run" });
      adapter.apply({ type: "artifact_published", artifactId: nativeId, title: path, uri: `file://${path}` });
      for (const event of adapter.events) {
        store.append(groupId, { ...event, runId: "group-run", payload: { ...event.payload, artifactId: `${bot.id}~${event.payload.artifactId}` } });
      }
      await versions.save({ conversationId: groupId, sourceConversationId: `${groupId}.m.${bot.id}`,
        artifactId: JSON.stringify(["group-run", "artifactId", `${bot.id}~${nativeId}`]), sourceArtifactId: nativeId,
        eventArtifactId: `${bot.id}~${nativeId}`, runId: "group-run", sourceRunId: `${groupId}.m.${bot.id}.child`,
        scope: "builder", path: "report.md", agent: "builder", name: "report.md", title: path, mimeType: "text/markdown",
        bytes: Buffer.from(bot.id), versionId: bot.versionId });
    }
    store.flush(groupId);
    const first = JSON.stringify(["group-run", "artifactId", `${bots[0].id}~published_version_${bots[0].versionId}`]);
    const response = await artifactVersionsResponse({ store, versions, layout, excluded: [dataDir], conversationId: groupId, artifactId: first });
    assert.equal(response.versions.length, 1);
    assert.equal(response.selectedVersionId, bots[0].versionId);
    assert.deepEqual(response.versions.map(version => version.artifactId), [first]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("quota counts an orphan snapshot file instead of allowing a bypass", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-quota-"));
  const store = new ArtifactVersionStore(join(root, "store"));
  try {
    mkdirSync(store.root, { recursive: true });
    const orphan = join(store.root, "orphan.bin");
    writeFileSync(orphan, Buffer.alloc(0));
    truncateSync(orphan, ARTIFACT_VERSION_MAX_TOTAL_BYTES);
    await assert.rejects(store.save(saveInput("11111111-1111-4111-8111-111111111111")), (error: unknown) => error instanceof ArtifactVersionError && error.status === 507);
    assert.equal(statSync(orphan).size, ARTIFACT_VERSION_MAX_TOTAL_BYTES);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a disk failure publishes no success event", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-disk-"));
  const cwd = join(root, "workspace"), dataDir = join(root, "data"), fileName = "report.md", storePath = join(root, "artifact-store");
  mkdirSync(cwd); writeFileSync(join(cwd, fileName), "disk failure"); writeFileSync(storePath, "not a directory");
  const bridgeFactory: PiBridgeFactory = async ({ hostTools }) => ({
    subscribe: () => () => {},
    async prompt() {
      const result = await hostTools?.run("publish_artifact", { path: fileName, preserveVersion: true });
      if (!result || result.isError) throw new Error(result?.text ?? "publish_artifact was not available");
    },
    abort: async () => {}, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
  });
  const host = createPiHttpHost({ cwd, dataDir, browser: false, routineClock: false, bridgeFactory, artifactVersions: new ArtifactVersionStore(storePath) });
  try {
    await host.controller.runPrompt({ conversationId: "disk-failure", requestId: "disk.run", prompt: "Deliver", agentPreset: "assistant" }, () => {});
    const conversation = host.controller.getConversation("disk-failure");
    assert.ok(conversation);
    assert.equal(conversation.events.some(event => event.type === "artifact.finished" && event.payload.status === "success"), false);
    assert.equal(statSync(storePath).isFile(), true);
  } finally { host.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("cancelling while save is in progress rolls back bytes and metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-cancel-save-"));
  const cwd = join(root, "workspace"), dataDir = join(root, "data"), fileName = "report.md";
  mkdirSync(cwd); writeFileSync(join(cwd, fileName), "cancel me");
  let entered!: () => void;
  let release!: () => void;
  const saveEntered = new Promise<void>(resolve => { entered = resolve; });
  const saveRelease = new Promise<void>(resolve => { release = resolve; });
  const store = new BlockingArtifactVersionStore(join(root, "store"), entered, saveRelease);
  const bridgeFactory: PiBridgeFactory = async ({ hostTools }) => ({
    subscribe: () => () => {},
    async prompt() {
      const result = await hostTools?.run("publish_artifact", { path: fileName, preserveVersion: true });
      if (!result || result.isError) throw new Error(result?.text ?? "publish_artifact was not available");
    },
    abort: async () => {}, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
  });
  const host = createPiHttpHost({ cwd, dataDir, browser: false, routineClock: false, bridgeFactory, artifactVersions: store });
  try {
    const running = host.controller.runPrompt({ conversationId: "cancel-save", requestId: "cancel.run", prompt: "Deliver", agentPreset: "assistant" }, () => {});
    await saveEntered;
    assert.equal(await host.controller.abort("cancel-save", "cancel.run"), true);
    release();
    await running;
    const conversation = host.controller.getConversation("cancel-save");
    assert.ok(conversation);
    assert.equal(conversation.events.some(event => event.type === "artifact.finished" && event.payload.status === "success"), false);
    assert.deepEqual(await store.list({ conversationId: "cancel-save", path: fileName, agent: "assistant", scope: "assistant" }), []);
    assert.deepEqual(readdirSync(store.root).filter(name => name.endsWith(".bin") || name.endsWith(".json")), []);
  } finally { host.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("artifactTools rejects a controlled read-time content mutation", async t => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-read-race-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root }); ensureWorkspaceLayout(layout);
  const fileName = "changing.md", file = join(layout.agents.assistant, fileName);
  writeFileSync(file, "before");
  let published = 0;
  try {
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    let mutated = false;
    t.mock.method(prototype, "read", async function(this: typeof probe, ...args: Parameters<typeof originalRead>) {
      const result = await originalRead.apply(this, args);
      if (!mutated) { mutated = true; writeFileSync(file, "after!"); }
      return result;
    });
    await probe.close();
    const tools = artifactTools(layout, "assistant", [], () => { published++; });
    const result = await tools.run("publish_artifact", { path: fileName, preserveVersion: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /file changed/i);
    assert.equal(mutated, true);
    assert.equal(published, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real group publishing keeps a dotted public run identity through HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-version-group-http-"));
  const cwd = join(root, "workspace"), dataDir = join(root, "data"), fileName = "报告 final.md";
  mkdirSync(cwd); writeFileSync(join(cwd, fileName), "group snapshot");
  const bridgeFactory: PiBridgeFactory = async ({ hostTools }) => ({
    subscribe: () => () => {},
    async prompt() {
      const result = await hostTools?.run("publish_artifact", { path: fileName, preserveVersion: true });
      if (!result || result.isError) throw new Error(result?.text ?? "publish_artifact was not available");
    },
    abort: async () => {}, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
  });
  const host = createPiHttpHost({ cwd, dataDir, browser: false, routineClock: false, bridgeFactory });
  let server: Server | undefined;
  try {
    ({ server } = await listen(host));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
    const requestId = "group.run.1";
    await host.controller.runGroupPrompt({ conversationId: "group.real", requestId, prompt: "@assistant 保存交付", agentPreset: "assistant" }, () => {});
    const conversation = host.controller.getConversation("group.real");
    assert.ok(conversation);
    const finished = conversation.events.find(event => event.type === "artifact.finished" && event.payload.status === "success"
      && typeof event.payload.artifactId === "string" && isVersionedArtifactId(event.payload.artifactId));
    assert.ok(finished);
    assert.equal(finished.runId, requestId);
    assert.match(String(finished.payload.artifactId), /^assistant~published_version_/);
    const catalog = await (await fetch(`${base}/artifacts?conversationId=group.real`)).json() as { artifacts: { artifactId: string }[] };
    assert.equal(catalog.artifacts.length, 1);
    const artifactId = catalog.artifacts[0].artifactId;
    assert.match(artifactId, /^\["group\.run\.1","artifactId","assistant~published_version_/);
    const versionsResponse = await fetch(`${base}/artifacts/versions?conversationId=group.real&artifactId=${encodeURIComponent(artifactId)}`);
    assert.equal(versionsResponse.status, 200);
    const versions = await versionsResponse.json() as { versions: { versionId: string; artifactId: string }[]; selectedVersionId: string; source: { scope: string; path: string } };
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].artifactId, artifactId);
    assert.deepEqual(versions.source, { scope: "assistant", path: fileName });
    const download = await fetch(`${base}/files/download?conversationId=group.real&artifactId=${encodeURIComponent(artifactId)}&versionId=${versions.selectedVersionId}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "group snapshot");
  } finally {
    if (server) await close(server, host); else host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
