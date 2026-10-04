import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ChannelBridge, questionAnswers, splitText, type ChannelRuntime, type InboundMessage } from "./channelBridge.ts";
import { ChannelStore } from "./channelStore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function chat() {
  const sent: string[] = [];
  const streamed: string[] = [];
  let id = 0;
  const message = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    messageId: `m${++id}`, chatId: "c1", chatType: "direct", senderId: "u1", text, mentioned: true,
    reply: {
      send: async (body) => { sent.push(body); },
      stream: async (initial) => {
        streamed.push(initial);
        return { update: async (body) => { streamed.push(body); }, finish: async (body) => { streamed.push(`final:${body}`); } };
      },
    },
    ...extra,
  });
  return { sent, streamed, message };
}

/** A runtime whose run says "hello", asks to write, and finishes once the approval is answered. */
function fakeRuntime() {
  const calls: { prompt: string; conversationId?: string; permissionMode?: string }[] = [];
  const decisions: string[] = [];
  let approve: ((decision: string) => void) | undefined;
  let stop: (() => void) | undefined;
  const runtime: ChannelRuntime = {
    configure: async () => ({}) as never,
    async runPrompt(input, onEvent) {
      calls.push({ prompt: input.prompt, conversationId: input.conversationId, permissionMode: input.permissionMode });
      const meta = { runId: input.requestId!, ts: 0, seq: 0, id: "e" };
      const emit = (type: string, payload: unknown) => onEvent({ ...meta, type, payload } as never);
      emit("text.started", { textId: "user", role: "user" });
      emit("text.delta", { textId: "user", delta: input.prompt });
      emit("text.started", { textId: "a1", role: "assistant" });
      emit("text.delta", { textId: "a1", delta: "hello" });
      if (input.prompt === "write") {
        emit("tool.call.started", { toolCallId: "t1", name: "write", title: "write" });
        emit("tool.call.awaiting_approval", { toolCallId: "t1", argsPreview: { path: "a.md" } });
        const decision = await new Promise<string>((resolve) => { approve = resolve; stop = () => resolve("stopped"); });
        decisions.push(decision);
        emit("tool.call.finished", { toolCallId: "t1", status: "success" });
        emit("run.finished", { status: decision === "stopped" ? "cancelled" : "success" });
        return;
      }
      emit("run.finished", { status: "success" });
    },
    resolveApproval: (toolCallId, decision) => { if (toolCallId !== "t1" || !approve) return false; approve(decision); approve = undefined; return true; },
    resolveUserInput: () => false,
    abort: async () => { stop?.(); return Boolean(stop); },
  };
  return { runtime, calls, decisions };
}

function setup(access: "allowlist" | "open" = "open") {
  const dir = mkdtempSync(join(tmpdir(), "rtb-channel-"));
  const store = new ChannelStore(join(dir, "im-channels.json"));
  store.update("telegram", { access, allowUsers: ["owner"], fields: { botToken: "secret-token" } });
  const fake = fakeRuntime();
  const denied: string[] = [];
  const bridge = new ChannelBridge({ platform: "telegram", runtime: fake.runtime, store, settings: () => store.get("telegram"),
    defaultPermissionMode: "request", onDenied: (sender) => { denied.push(sender.id); } });
  return { ...fake, dir, store, bridge, denied, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the allowlist turns strangers away with their id, and only addressed group messages run", async () => {
  const { bridge, calls, denied, cleanup } = setup("allowlist");
  const { sent, message } = chat();
  try {
    await bridge.handle(message("hi", { senderId: "stranger" }));
    assert.deepEqual(denied, ["stranger"]);
    assert.match(sent[0], /stranger/);
    await bridge.handle(message("hi", { senderId: "stranger", chatType: "group" }));
    assert.equal(sent.length, 1, "a group stranger is not answered in the group");
    await bridge.handle(message("hi", { senderId: "owner", chatType: "group", mentioned: false }));
    assert.equal(calls.length, 0);
  } finally { cleanup(); }
});

test("a turn streams its answer, waits for an approval given in chat, and keeps one conversation per chat", async () => {
  const { bridge, calls, decisions, store, dir, cleanup } = setup();
  const { sent, streamed, message } = chat();
  try {
    const first = message("write");
    await bridge.handle(first);
    await tick();
    assert.match(sent.at(-1)!, /需要你的批准：write/);
    await bridge.handle(first);
    assert.equal(calls.length, 1, "a redelivered message is ignored");
    await bridge.handle(message("另一个任务"));
    assert.match(sent.at(-1)!, /等待批准/, "anything but a decision is a reminder while approval is pending");
    await bridge.handle(message("同意"));
    await tick();
    assert.deepEqual(decisions, ["yes"]);
    assert.equal(streamed.at(-1), "final:hello");
    assert.equal(calls[0].permissionMode, "request");
    await bridge.handle(message("again"));
    await tick();
    assert.equal(calls[1].conversationId, calls[0].conversationId);
    await bridge.handle(message("/new"));
    await bridge.handle(message("fresh"));
    await tick();
    assert.notEqual(calls[2].conversationId, calls[0].conversationId);
    assert.equal(store.conversationFor("telegram:direct:c1"), calls[2].conversationId);
    assert.equal(statSync(join(dir, "im-channels.json")).mode & 0o777, 0o600);
  } finally { cleanup(); }
});

test("/stop ends the running turn and says so", async () => {
  const { bridge, decisions, cleanup } = setup();
  const { sent, streamed, message } = chat();
  try {
    await bridge.handle(message("write"));
    await tick();
    await bridge.handle(message("/stop"));
    await tick();
    assert.deepEqual(decisions, ["stopped"]);
    assert.equal(sent.at(-1), "已停止当前任务。");
    assert.match(streamed.at(-1)!, /已停止/);
  } finally { cleanup(); }
});

test("a saved secret survives a patch with an empty field and is read back from disk", () => {
  const { store, dir, cleanup } = setup();
  try {
    store.update("telegram", { fields: { botToken: "" }, enabled: true });
    const reloaded = new ChannelStore(join(dir, "im-channels.json"));
    assert.equal(reloaded.get("telegram").credentials.botToken, "secret-token");
    assert.equal(reloaded.get("telegram").enabled, true);
    assert.equal(JSON.parse(readFileSync(join(dir, "im-channels.json"), "utf8")).channels.feishu, undefined);
  } finally { cleanup(); }
});

test("chat answers map to options by number or label, one line per question", () => {
  const questions = [
    { id: "a", header: "", question: "Color?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false, allowOther: false },
    { id: "b", header: "", question: "Tags?", options: [{ label: "x", description: "" }, { label: "y", description: "" }], multiSelect: true, allowOther: true },
  ];
  assert.deepEqual(questionAnswers("2\n1, z", questions), { value: { a: ["Blue"], b: ["x", "z"] } });
  assert.deepEqual(questionAnswers("red\ny", questions), { value: { a: ["Red"], b: ["y"] } });
  assert.equal(questionAnswers("green\ny", questions), undefined);
  assert.equal(questionAnswers("1", questions), undefined, "missing a line");
  assert.deepEqual(questionAnswers("跳过", questions), { value: null });
});

test("long replies split on line breaks within the limit", () => {
  const pieces = splitText(`${"a".repeat(6)}\n${"b".repeat(6)}`, 8);
  assert.deepEqual(pieces, ["aaaaaa", "bbbbbb"]);
  assert.ok(splitText("x".repeat(20), 8).every((piece) => piece.length <= 8));
});

test("/stop while the reply is still being prepared cancels the turn before it starts", async () => {
  const { bridge, calls, cleanup } = setup();
  const { sent, streamed, message } = chat();
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const slow = message("hello", {});
  const stream = slow.reply.stream!;
  slow.reply.stream = async (initial) => { await opened; return stream(initial); };
  try {
    await bridge.handle(slow);
    await bridge.handle(message("/stop"));
    assert.equal(sent.at(-1), "已停止当前任务。");
    open();
    await tick();
    assert.equal(calls.length, 0, "the stopped turn never reaches the runtime");
    assert.match(streamed.at(-1)!, /已停止/);
  } finally { cleanup(); }
});
