import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { replayAgentUXEvents } from "@agent-ux/runtime";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { artifactEventForReplay } from "../runtime/artifactContent.ts";
import { historyFeedbackEvents } from "../runtime/historyFeedback.ts";
import { identityEventForReplay } from "../runtime/replayIdentity.ts";
import { branchReplayEvents } from "../runtime/useMessageBranch.ts";
import { userInputEventsForReplay } from "../runtime/userInput.ts";
import { workArtifacts } from "../runtime/workArtifacts.ts";
import { createConversationStore } from "./conversationStore.ts";
import { listArtifactCatalog } from "./artifactCatalog.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rtb-artifact-catalog-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root }); ensureWorkspaceLayout(layout);
  const dataDir = join(root, "private"), store = createConversationStore(dataDir);
  const add = (conversationId: string, name: string, timestamp: number, artifactId = "file", path = join(layout.agents.assistant, name), runId = `run-${timestamp}`) => {
    if (!store.get(conversationId)) store.begin(conversationId, "assistant", `Source ${conversationId}`);
    const adapter = createPiEventAdapter({ runId });
    adapter.apply({ type: "artifact_published", artifactId, title: path, uri: `file://${path}` });
    for (const event of adapter.events) store.append(conversationId, { ...event, ts: timestamp });
    store.flush(conversationId);
    return adapter.events.filter(e => e.type === "artifact.finished").map(identityEventForReplay)[0].payload.artifactId;
  };
  const list = (input: Partial<Parameters<typeof listArtifactCatalog>[0]> = {}) => listArtifactCatalog({ store, layout, excluded: [dataDir], ...input });
  return { root, layout, store, dataDir, add, list, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("artifact retrieval searches all conversations before paging and keeps exact replay identities", async () => {
  const f = setup();
  try {
    writeFileSync(join(f.layout.agents.assistant, "report.md"), "actual report");
    const old = f.add("one", "report.md", 10);
    const latest = f.add("one", "report.md", 30); // Same native id, different run, same file.
    const second = f.add("two", "report.md", 20);
    writeFileSync(join(f.layout.agents.assistant, "different.txt"), "other");
    f.add("three", "different.txt", 40);
    const first = await f.list({ query: "report", limit: 1 });
    assert.deepEqual(first.artifacts.map(row => row.artifactId), [latest]);
    assert.notEqual(latest, old);
    assert.equal(first.artifacts[0].timestamp, 30);
    assert.equal(first.artifacts[0].conversationTitle, "Source one");
    assert.equal(first.artifacts[0].path, "report.md");
    assert.equal(first.artifacts[0].available, true);
    assert.ok(first.nextCursor);
    const next = await f.list({ query: "report", limit: 1, cursor: first.nextCursor });
    assert.deepEqual(next.artifacts.map(row => row.artifactId), [second]);
    assert.equal(next.nextCursor, undefined);
    assert.equal(first.truncated, false);
    assert.equal(JSON.stringify(first).includes("actual report"), false);
    assert.equal((await f.list({ query: "Source two" })).artifacts.length, 1);
    await assert.rejects(f.list({ query: "different", cursor: first.nextCursor }), /cursor/);
    await assert.rejects(f.list({ limit: 1000 }), /page size/);
  } finally { f.close(); }
});

test("catalog excludes hidden conversations, private/outside/link files and non-deliverables", async () => {
  const f = setup();
  try {
    const work = f.layout.agents.assistant;
    for (const name of ["visible.md", "plan.md", "code.ts", ".hidden.md"]) writeFileSync(join(work, name), "not returned as content");
    writeFileSync(join(f.dataDir, "secret.md"), "private");
    const privateDir = join(work, "private");
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, "secret.md"), "private inside workspace");
    symlinkSync(join(work, "visible.md"), join(work, "linked.md"));
    writeFileSync(join(work, "original.md"), "linked file");
    linkSync(join(work, "original.md"), join(work, "hardlink.md"));
    f.add("visible", "visible.md", 10);
    f.add("hidden.m.assistant", "visible.md", 20);
    f.add("visible", "plan.md", 30, "plan_run");
    f.add("visible", "code.ts", 40, "code");
    f.add("visible", ".hidden.md", 50, "hidden");
    f.add("visible", "linked.md", 60, "linked");
    f.add("visible", "secret.md", 70, "private", join(f.dataDir, "secret.md"));
    f.add("visible", "outside.md", 80, "outside", "/outside/report.md");
    f.add("visible", "traversal.md", 90, "traversal", `${work}/../assistant/visible.md`);
    f.add("visible", "private.md", 100, "private-inside", join(privateDir, "secret.md"));
    f.add("visible", "gone-private.md", 110, "gone-private", join(privateDir, "missing.md"));
    f.add("visible", "hardlink.md", 120, "hardlink");
    const result = await f.list({ excluded: [f.dataDir, privateDir] });
    assert.deepEqual(result.artifacts.map(row => row.name), ["visible.md"]);
    await assert.rejects(f.list({ conversationId: "hidden.m.assistant" }), /visible conversation/);
  } finally { f.close(); }
});

test("history budgets report incomplete results and stop before loading or replaying beyond their limits", async () => {
  const f = setup();
  try {
    f.add("sample", "report.md", 10);
    const sample = f.store.get("sample")!;
    const { events, ...metadata } = sample;
    let loaded = 0;
    const summaries = Array.from({ length: 1001 }, (_, index) => ({ ...metadata, id: `conversation-${index}`, eventCount: 0 }));
    const capped = await f.list({ store: {
      list: () => summaries, readErrors: () => [],
      get: id => { loaded++; return { ...sample, id, events: [] }; },
    } });
    assert.equal(loaded, 1000);
    assert.equal(capped.truncated, true);
    assert.equal(capped.artifacts.length, 0);
    const large = await f.list({ store: {
      list: () => [{ ...metadata, eventCount: 200_001 }], readErrors: () => [],
      get: () => ({ ...sample, events: Array(200_001).fill(events[0]) }),
    } });
    assert.equal(large.truncated, true);
    assert.equal(large.artifacts.length, 0);
    assert.equal(large.unreadable, 0);
  } finally { f.close(); }
});

test("missing registered files and unreadable history are explicit; newer inserts do not duplicate seek pages", async () => {
  const f = setup();
  try {
    f.add("missing", "gone.pdf", 10);
    f.add("newer", "report.md", 20);
    writeFileSync(join(f.store.dir, "broken.json"), "{");
    const first = await f.list({ limit: 1 });
    assert.equal(first.artifacts[0].available, false);
    assert.equal(first.unreadable, 1);
    f.add("newest", "new.pdf", 30);
    const second = await f.list({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.artifacts[0].conversationId, "missing");
    assert.equal(second.nextCursor, undefined);
    const scoped = await f.list({ conversationId: "missing" });
    assert.equal(scoped.unreadable, 0);
    assert.equal(scoped.artifacts.length, 1);
  } finally { f.close(); }
});

test("group artifact ownership permits only its actual member workspace and the shared workspace", async () => {
  const f = setup();
  try {
    const member = "bot_11111111-1111-1111-1111-111111111111";
    f.store.begin("group", "assistant", "Research group");
    f.store.setExtra("group", { group: { members: [member], lines: [], participants: [{ id: member, name: "Builder", presetId: "builder" }] } });
    writeFileSync(join(f.layout.agents.builder, "member.md"), "member");
    writeFileSync(join(f.layout.shared!, "shared.md"), "shared");
    f.add("group", "member.md", 10, `${member}~one`, join(f.layout.agents.builder, "member.md"));
    f.add("group", "shared.md", 20, `${member}~two`, join(f.layout.shared!, "shared.md"));
    f.add("group", "other.md", 30, "planner~wrong", join(f.layout.agents.builder, "member.md"));
    assert.deepEqual((await f.list()).artifacts.map(row => row.name), ["shared.md", "member.md"]);
  } finally { f.close(); }
});

test("branch catalog results match the source UI replay without inheriting excluded later runs", async () => {
  const f = setup();
  try {
    const first = f.add("source", "common.md", 10, "first-file", undefined, "first");
    f.store.saveTurn("source", { runId: "first", harness: "pi", prompt: "First request" });
    const later = f.add("source", "later.md", 20, "later-file", undefined, "second");
    f.store.saveTurn("source", { runId: "second", harness: "pi", prompt: "Later request" });
    f.store.saveNativeTurn("source", "second", { harness: "pi", sessionId: "native", sourceId: "source", beforeEntryId: "first-reply" });
    f.store.branch("branch", "source", "second");
    const edited = f.add("branch", "edited.md", 30, "edited-file", undefined, "edited");
    const catalog = await f.list();
    assert.deepEqual(catalog.artifacts.filter(row => row.conversationId === "source").map(row => row.artifactId), [later, first]);
    assert.deepEqual(catalog.artifacts.filter(row => row.conversationId === "branch").map(row => row.artifactId), [edited, first]);
    for (const conversationId of ["source", "branch"]) {
      const conversation = f.store.get(conversationId)!;
      const projected = branchReplayEvents(userInputEventsForReplay(historyFeedbackEvents(conversation.events, conversationId, "History notice")))
        .map(identityEventForReplay).map(artifactEventForReplay);
      const visible = workArtifacts(createAgentUXViewModel(replayAgentUXEvents(projected), { policy: { visibility: { show: "developer" } } }).timeline);
      const ids = new Set(visible.map(artifact => artifact.id));
      assert.ok(catalog.artifacts.filter(row => row.conversationId === conversationId).every(row => ids.has(row.artifactId)));
    }
  } finally { f.close(); }
});
