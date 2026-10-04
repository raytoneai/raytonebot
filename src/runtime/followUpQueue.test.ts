import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { hasSavedState, readComposerDrafts, savedComposerDraft } from "./composerDraftStore.ts";
import { enqueueDraft, lastRunOutcome, nextQueueStep, queuedPrompt, withoutAccepted, type FollowUpQueue } from "./followUpQueue.ts";

const finished = (runId: string, status?: string) => ({ type: "run.finished", runId, payload: status ? { status } : {} }) as unknown as AgentUXEvent;
const failed = (runId: string) => ({ type: "run.error", runId, payload: { message: "x" } }) as unknown as AgentUXEvent;
const item = (id: string, prompt = id) => ({ id, createdAt: 1, prompt, attachments: [] });

test("queuing moves text and files out of the draft, keeps the conversation's options and snapshots the chosen ones", () => {
  const file = { id: "f", file: new File(["x"], "notes.txt"), name: "notes.txt", isImage: false };
  const { item: queued, draft } = enqueueDraft({ prompt: "  next  ", attachments: [file], runOptions: { budgetMode: "expert" } },
    { permissionMode: "auto", budgetMode: "fast" }, "pi_export_a", 5);
  assert.deepEqual(draft, { prompt: "", attachments: [], runOptions: { budgetMode: "expert" } });
  assert.deepEqual(queued, { id: "pi_export_a", createdAt: 5, prompt: "  next  ", attachments: [file], runOptions: { permissionMode: "auto", budgetMode: "fast" } });
  assert.equal(queuedPrompt(queued), "next");
  assert.equal(queuedPrompt({ prompt: " ", attachments: [file] }), "notes.txt", "file-only follow-ups send like the composer does");
});

test("the head is sent only after a turn that ended well, one at a time and in order", () => {
  const queue: FollowUpQueue = { items: [item("a"), item("b")] };
  assert.deepEqual(nextQueueStep(queue, { running: true, events: [], connectionFailed: false }), { kind: "wait" });
  assert.deepEqual(nextQueueStep(queue, { running: false, events: [finished("r1")], connectionFailed: false }), { kind: "send", item: queue.items[0] });
  assert.deepEqual(nextQueueStep(queue, { running: false, events: [finished("r1", "success")], connectionFailed: false }).kind, "send");
  assert.deepEqual(nextQueueStep({ items: [] }, { running: false, events: [], connectionFailed: false }), { kind: "wait" });
});

test("a stop, failure, rejection or lost connection pauses instead of sending; resuming skips only the acknowledged terminal", () => {
  const queue: FollowUpQueue = { items: [item("a")] };
  const idle = (events: AgentUXEvent[], connectionFailed = false) => nextQueueStep(queue, { running: false, events, connectionFailed });
  assert.deepEqual(idle([finished("r1", "cancelled")]), { kind: "pause", reason: "stopped" });
  assert.deepEqual(idle([finished("r1"), failed("r2")]), { kind: "pause", reason: "failed" });
  assert.deepEqual(idle([finished("r1", "interrupted")]), { kind: "pause", reason: "failed" }, "unknown terminals are not success");
  assert.deepEqual(idle([finished("r1")], true), { kind: "pause", reason: "failed" }, "an unconfirmed host outcome never sends");
  assert.deepEqual(nextQueueStep({ ...queue, paused: "restored" }, { running: false, events: [finished("r1")], connectionFailed: false }), { kind: "wait" });
  const resumed = { ...queue, settledRunId: "r2" };
  assert.equal(nextQueueStep(resumed, { running: false, events: [failed("r2")], connectionFailed: false }).kind, "send");
  assert.deepEqual(nextQueueStep(resumed, { running: false, events: [failed("r2"), failed("a")], connectionFailed: false }), { kind: "pause", reason: "failed" },
    "a follow-up that fails after resuming pauses again");
  assert.deepEqual(lastRunOutcome([finished("r1"), { type: "text.delta", payload: {} } as unknown as AgentUXEvent]), { runId: "r1", status: "success" });
});

test("items the host already accepted are dropped and never resent", () => {
  const queue: FollowUpQueue = { items: [item("a"), item("b"), item("c")], paused: "restored" };
  assert.deepEqual(withoutAccepted(queue, new Set(["a", "c"])).items.map((entry) => entry.id), ["b"]);
  assert.equal(withoutAccepted(queue, new Set(["other"])), queue);
});

test("the queue persists with the draft, without allow-all, and restores only well-formed items", async () => {
  const conversation = { id: "c", title: "C", createdAt: 1, agentPreset: "assistant", events: [] };
  const file = new File([new Uint8Array([7, 8])], "a.bin");
  const queued = { id: "q1", createdAt: 2, prompt: "follow up", attachments: [{ id: "f", file, name: "a.bin", isImage: false, imageSrc: "data:unused" }],
    runOptions: { permissionMode: "allow-all" as const, budgetMode: "fast" as const } };
  const record = savedComposerDraft(conversation, { prompt: "", attachments: [] }, undefined, [queued]);
  assert.equal(hasSavedState(record), true, "an empty draft with queued items is not deleted");
  assert.equal(hasSavedState(savedComposerDraft(conversation, { prompt: "", attachments: [] })), false);
  assert.deepEqual(record.queue?.[0].runOptions, { budgetMode: "fast" }, "a reload never re-arms unattended access");
  assert.equal(record.queue?.[0].attachments[0].imageSrc, undefined);
  const stored = [{ ...record, queue: [...record.queue!, { id: 3, prompt: "bad" }, { id: "q2", prompt: "no files" },
    { id: "q3", createdAt: 4, prompt: "evil", attachments: [], runOptions: { permissionMode: "root" } }] }];
  const db = { transaction: () => ({ objectStore: () => ({ getAll() {
    const request: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => { request.result = stored; request.onsuccess?.(); });
    return request;
  } }) }) } as unknown as IDBDatabase;
  const [restored] = await readComposerDrafts(db);
  assert.deepEqual(restored.queue?.map((entry) => entry.id), ["q1", "q3"]);
  assert.deepEqual(restored.queue?.[1].runOptions, { permissionMode: "request" }, "malformed options cannot broaden access");
  assert.deepEqual(new Uint8Array(await restored.queue![0].attachments[0].file!.arrayBuffer()), new Uint8Array([7, 8]));
});
