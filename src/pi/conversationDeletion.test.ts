import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUXEvent } from "@agent-ux/protocol";

import { createPiRuntimeController, type PiBridgeFactory } from "./piHost.ts";
import { childConversationId } from "./groupChat.ts";
import { ConversationRequestError } from "./conversationRequestError.ts";
import { createConversationStore } from "./conversationStore.ts";

const isConflict = (error: unknown) => error instanceof ConversationRequestError && error.status === 409;

function bridgeFactory(options: {
  onConfigure?: (id: string) => Promise<void>;
  onReset?: (id: string) => Promise<void>;
  onPrompt?: (id: string, prompt: string) => void;
  onDispose?: (id: string) => void;
  tools?: string[];
} = {}): PiBridgeFactory {
  return async ({ sessionDir }) => {
    const id = decodeURIComponent(sessionDir!.split("/").pop()!);
    return {
      subscribe: () => () => {},
      async prompt(prompt) { options.onPrompt?.(id, prompt); },
      async abort() {},
      dispose() { options.onDispose?.(id); },
      async configure() { await options.onConfigure?.(id); },
      async newSession() { await options.onReset?.(id); },
      async state() { return { models: [], tools: options.tools ?? [] }; },
    };
  };
}

test("deleting a conversation drops its bridge and capability announcement before id reuse", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-conversation-delete-reuse-"));
  let bridges = 0;
  const prompts: string[] = [];
  const events: AgentUXEvent[][] = [];
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, bridgeFactory: async input => {
    bridges++;
    return bridgeFactory({ tools: ["read_file"], onPrompt: (_id, prompt) => prompts.push(prompt) })(input);
  } });
  try {
    await controller.runPrompt({ conversationId: "reuse", requestId: "first", prompt: "old context" }, event => (events[0] ??= []).push(event));
    controller.deleteConversation("reuse");
    assert.equal(controller.getConversation("reuse"), undefined);
    await controller.runPrompt({ conversationId: "reuse", requestId: "second", prompt: "new context" }, event => (events[1] ??= []).push(event));
    assert.equal(bridges, 2, "id reuse must create a fresh bridge");
    assert.doesNotMatch(prompts[1], /old context/, "the new id must not receive the deleted transcript");
    assert.equal(events[0].filter(event => event.type === "capability.attached").length, 1);
    assert.equal(events[1].filter(event => event.type === "capability.attached").length, 1, "capabilities must be announced again");
  } finally {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deletion rejects a pending configuration and leaves the conversation record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-conversation-delete-config-"));
  const store = createConversationStore(dataDir);
  store.begin("configuring", "assistant", "saved");
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store,
    bridgeFactory: bridgeFactory({ onConfigure: async () => { entered(); await pending; } }) });
  try {
    const configuring = controller.configure({ conversationId: "configuring", model: "new" });
    await enteredPromise;
    assert.throws(() => controller.deleteConversation("configuring"), isConflict);
    assert.ok(controller.getConversation("configuring"));
    release();
    await configuring;
    controller.deleteConversation("configuring");
    assert.equal(controller.getConversation("configuring"), undefined);
  } finally {
    release?.();
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("group deletion preflights every hidden child before removing any record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-conversation-delete-group-"));
  const store = createConversationStore(dataDir);
  const groupId = "group-delete";
  const busyChild = childConversationId(groupId, "planner");
  const otherChild = childConversationId(groupId, "builder");
  store.begin(groupId, "assistant", "group");
  store.setExtra(groupId, { group: { members: ["planner", "builder"], participants: [
    { id: "planner", name: "Tonny", presetId: "planner" },
    { id: "builder", name: "Bob", presetId: "builder" },
  ], lines: [] } });
  store.begin(busyChild, "planner", "child");
  store.begin(otherChild, "builder", "child");
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store,
    bridgeFactory: bridgeFactory({ onConfigure: async id => { if (id === busyChild) { entered(); await pending; } } }) });
  try {
    const configuring = controller.configure({ conversationId: busyChild, model: "new" });
    await enteredPromise;
    assert.throws(() => controller.deleteConversation(groupId), isConflict);
    assert.ok(controller.getConversation(groupId));
    assert.ok(controller.getConversation(otherChild));
    release();
    await configuring;
    controller.deleteConversation(groupId);
    assert.equal(controller.getConversation(groupId), undefined);
    assert.equal(controller.getConversation(busyChild), undefined);
    assert.equal(controller.getConversation(otherChild), undefined);
  } finally {
    release?.();
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("group deletion preflights a known child that has not created a record yet", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-conversation-delete-unrecorded-child-"));
  const store = createConversationStore(dataDir);
  const groupId = "group-unrecorded-child";
  const busyChild = childConversationId(groupId, "planner");
  store.begin(groupId, "assistant", "group");
  store.setExtra(groupId, { group: { members: ["planner"], participants: [{ id: "planner", name: "Tonny", presetId: "planner" }], lines: [] } });
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store,
    bridgeFactory: bridgeFactory({ onConfigure: async id => { if (id === busyChild) { entered(); await pending; } } }) });
  try {
    const configuring = controller.configure({ conversationId: busyChild, model: "new" });
    await enteredPromise;
    assert.equal(controller.getConversation(busyChild), undefined);
    assert.throws(() => controller.deleteConversation(groupId), isConflict);
    assert.ok(controller.getConversation(groupId));
    release();
    await configuring;
    controller.deleteConversation(groupId);
    assert.equal(controller.getConversation(groupId), undefined);
  } finally {
    release?.();
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a group's own pending reset rejects deletion while preserving its parent record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-conversation-delete-group-reset-"));
  const store = createConversationStore(dataDir);
  const groupId = "group-reset-delete";
  store.begin(groupId, "assistant", "group");
  store.setExtra(groupId, { group: { members: ["planner"], participants: [{ id: "planner", name: "Tonny", presetId: "planner" }], lines: [] } });
  const childId = childConversationId(groupId, "planner");
  store.begin(childId, "planner", "child");
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, store,
    bridgeFactory: bridgeFactory({ onReset: async id => { if (id === childId) { entered(); await pending; } } }) });
  try {
    const resetting = controller.newSession(groupId);
    await enteredPromise;
    assert.throws(() => controller.deleteConversation(groupId), isConflict);
    assert.ok(controller.getConversation(groupId));
    release();
    await resetting;
  } finally {
    release?.();
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
