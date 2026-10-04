import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { conversationTitle, createConversationStore } from "./conversationStore.ts";

const event = (type: string, seq: number) => ({ type, seq, id: `e${seq}`, runId: "r", ts: seq, payload: {} }) as never;

test("conversations survive a new store instance (a server restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-"));
  try {
    const first = createConversationStore(dir);
    first.begin("c1", "planner", "plan the   release\nnow");
    first.append("c1", event("run.started", 1));
    first.append("c1", event("run.started", 1));
    first.flush("c1");
    first.setCliSession("c1", { harness: "claude-code", id: "sess-1" });
    first.begin("c2", "assistant", "hi");

    const second = createConversationStore(dir);
    const restored = second.get("c1");
    assert.equal(restored?.title, "plan the release now");
    assert.equal(restored?.agentPreset, "planner");
    assert.deepEqual(restored?.events.map((entry) => (entry as { seq: number }).seq), [1, 2], "seq is conversation-wide");
    assert.deepEqual(restored?.cliSession, { harness: "claude-code", id: "sess-1" });
    assert.deepEqual(second.list().map((entry) => entry.id).sort(), ["c1", "c2"]);
    assert.equal(second.list().find((entry) => entry.id === "c1")?.eventCount, 2);
    assert.ok(!readdirSync(join(dir, "conversations")).some((name) => name.endsWith(".tmp")), "no half-written files");

    second.reset("c1");
    assert.equal(createConversationStore(dir).get("c1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ids cannot escape the store directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-"));
  try {
    const store = createConversationStore(dir);
    assert.throws(() => store.begin("../../etc/passwd", "assistant", "x"));
    assert.equal(existsSync(join(dir, "..", "etc")), false);
    assert.equal(conversationTitle(""), "New conversation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creating more than 200 conversations never silently deletes history", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-retention-"));
  try {
    const store = createConversationStore(dir);
    for (let index = 0; index < 205; index++) store.begin(`c${index}`, "assistant", "Keep this");
    assert.equal(createConversationStore(dir).list().length, 205);
    assert.ok(createConversationStore(dir).get("c0"));
    store.remove("c0");
    assert.equal(createConversationStore(dir).list().length, 204, "only explicit deletion removes history");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable history is reported alongside healthy records and cannot be overwritten as a new conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-corrupt-"));
  try {
    const store = createConversationStore(dir);
    store.begin("healthy", "assistant", "Keep this conversation");
    const broken = join(store.dir, "broken.json");
    for (const contents of ['{"events":', '{"id":"broken","events":null}', '{"id":"different","events":[]}',
      JSON.stringify({ ...store.get("healthy"), id: "broken", piSessionId: "" })]) {
      writeFileSync(broken, contents);
      assert.throws(() => store.get("broken"), /could not be read/);
      assert.throws(() => store.begin("broken", "assistant", "new prompt"), /could not be read/);
      assert.equal(readFileSync(broken, "utf8"), contents);
      assert.deepEqual(store.list().map((entry) => entry.id), ["healthy"]);
      assert.deepEqual(store.readErrors(), ["broken"]);
    }
    const recovered = { ...store.get("healthy"), id: "broken" };
    writeFileSync(broken, JSON.stringify(recovered));
    assert.equal(store.get("broken")?.title, "Keep this conversation");
    assert.equal(store.list().length, 2);
    assert.deepEqual(store.readErrors(), []);
    assert.equal(store.get("missing"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed writes do not publish new conversation metadata or native session bindings to the cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-write-"));
  try {
    const store = createConversationStore(dir);
    store.begin("existing", "assistant", "Keep original metadata");
    const disk = readFileSync(join(store.dir, "existing.json"), "utf8");
    for (const id of ["existing", "new"]) mkdirSync(join(store.dir, id + ".json.tmp"));
    assert.throws(() => store.begin("new", "builder", "not saved"), /could not be saved/);
    assert.equal(store.get("new"), undefined);
    assert.throws(() => store.begin("existing", "planner", "not saved"));
    assert.equal(store.get("existing")?.agentPreset, "assistant");
    assert.throws(() => store.setCliSession("existing", { harness: "codex", id: "not-saved" }));
    assert.equal(store.get("existing")?.cliSession, undefined);
    assert.throws(() => store.setPiSession("existing", "not-saved"));
    assert.equal(store.get("existing")?.piSessionId, null);
    assert.equal(readFileSync(join(store.dir, "existing.json"), "utf8"), disk);
    store.append("existing", event("run.finished", 1));
    assert.throws(() => store.flush("existing"), /could not be saved/);
    assert.deepEqual(store.get("existing")?.events, [], "a failed flush cannot publish an unsaved terminal through the cache");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browsing and searching old history cannot evict buffered events from concurrent conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-pressure-"));
  try {
    const store = createConversationStore(dir);
    for (let n = 0; n < 60; n++) store.begin(`old-${n}`, "assistant", `Archive ${n}`);
    for (const id of ["a", "b", "c"]) {
      store.begin(id, "assistant", `Live ${id}`);
      store.append(id, event("run.started", 1));
    }
    assert.equal(store.list().length, 63);
    assert.equal(store.list("Archive").length, 60);
    for (let n = 0; n < 60; n++) store.get(`old-${n}`);
    for (const id of ["a", "b", "c"]) {
      assert.equal(store.list().find(row => row.id === id)?.eventCount, 1);
      assert.equal(createConversationStore(dir).get(id)?.events.length, 0, "browsing must not force uncommitted events to disk");
      store.append(id, event("run.finished", 2));
      store.flush(id);
    }
    for (let n = 0; n < 60; n++) store.get(`old-${n}`);
    for (const id of ["a", "b", "c"]) {
      assert.deepEqual(store.get(id)?.events.map(e => [e.type, e.seq]), [["run.started", 1], ["run.finished", 2]]);
      assert.deepEqual(createConversationStore(dir).get(id)?.events, store.get(id)?.events);
    }
    store.remove("old-0"); store.reset("b");
    assert.equal(store.list().length, 61);
    assert.equal(store.list("Archive").length, 59);
    assert.equal(store.get("b"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed writes discard buffered metadata even after other histories displace saved bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-pressure-failed-"));
  try {
    const store = createConversationStore(dir);
    store.begin("live", "assistant", "Keep the committed prefix");
    store.append("live", event("run.started", 1)); store.flush("live");
    const committed = readFileSync(join(store.dir, "live.json"), "utf8");
    store.append("live", event("run.finished", 2));
    for (let n = 0; n < 60; n++) store.begin(`old-${n}`, "assistant", "Archive");
    assert.equal(store.list().find(row => row.id === "live")?.eventCount, 2);
    mkdirSync(join(store.dir, "live.json.tmp"));
    assert.throws(() => store.flush("live"), /could not be saved/);
    assert.equal(store.list().find(row => row.id === "live")?.eventCount, 1);
    assert.deepEqual(store.get("live")?.events, JSON.parse(committed).events);
    rmSync(join(store.dir, "live.json.tmp"), { recursive: true });
    store.append("live", event("run.error", 2)); store.flush("live");
    assert.deepEqual(createConversationStore(dir).get("live")?.events.map(e => e.type), ["run.started", "run.error"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an evicted transcript's read failure also invalidates its warm summary until repair", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-store-pressure-read-"));
  try {
    const store = createConversationStore(dir);
    store.begin("target", "assistant", "Recover this record");
    const file = join(store.dir, "target.json"), committed = readFileSync(file, "utf8");
    for (let n = 0; n < 60; n++) store.begin(`old-${n}`, "assistant", "Archive");
    writeFileSync(file, '{"events":');
    assert.throws(() => store.get("target"), /could not be read/);
    assert.equal(store.list().some(row => row.id === "target"), false, "a stale summary cannot conceal a known read error");
    assert.deepEqual(store.readErrors(), ["target"]);
    writeFileSync(file, committed);
    assert.equal(store.list().find(row => row.id === "target")?.title, "Recover this record");
    assert.deepEqual(store.readErrors(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
