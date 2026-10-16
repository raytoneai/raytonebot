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

/** A turn whose engine runs two tools at once, so both approvals are held before either is answered. */
function parallelRuntime() {
  const decisions: Record<string, string> = {};
  const waiters = new Map<string, (decision: string) => void>();
  const runtime: ChannelRuntime = {
    configure: async () => ({}) as never,
    async runPrompt(input, onEvent) {
      const meta = { runId: input.requestId!, ts: 0, seq: 0, id: "e" };
      const emit = (type: string, payload: unknown) => onEvent({ ...meta, type, payload } as never);
      for (const call of [{ id: "t1", name: "write" }, { id: "t2", name: "bash" }]) {
        emit("tool.call.started", { toolCallId: call.id, name: call.name, title: call.name });
        emit("tool.call.awaiting_approval", { toolCallId: call.id, argsPreview: { call: call.id } });
      }
      await Promise.all(["t1", "t2"].map((id) => new Promise<void>((resolve) => waiters.set(id, (decision) => { decisions[id] = decision; resolve(); }))));
      emit("run.finished", { status: "success" });
    },
    resolveApproval: (toolCallId, decision) => {
      const resolve = waiters.get(toolCallId);
      if (!resolve) return false;
      waiters.delete(toolCallId);
      resolve(decision);
      return true;
    },
    resolveUserInput: () => false,
    abort: async () => false,
  };
  return { runtime, decisions };
}

/** A turn that asks for one approval, and for a second only once the first has been answered. */
function stagedRuntime() {
  const decisions: Record<string, string> = {};
  const waiters = new Map<string, (decision: string) => void>();
  const runtime: ChannelRuntime = {
    configure: async () => ({}) as never,
    async runPrompt(input, onEvent) {
      const meta = { runId: input.requestId!, ts: 0, seq: 0, id: "e" };
      const emit = (type: string, payload: unknown) => onEvent({ ...meta, type, payload } as never);
      const ask = (id: string, name: string) => {
        emit("tool.call.started", { toolCallId: id, name, title: name });
        emit("tool.call.awaiting_approval", { toolCallId: id, argsPreview: { call: id } });
      };
      ask("t1", "write");
      await new Promise<void>((resolve) => waiters.set("t1", (decision) => { decisions.t1 = decision; resolve(); }));
      // Only now does the engine ask for the second tool: this lands while the chat is still sending
      // its "已批准" reply for the first.
      ask("t2", "bash");
      await new Promise<void>((resolve) => waiters.set("t2", (decision) => { decisions.t2 = decision; resolve(); }));
      emit("run.finished", { status: "success" });
    },
    resolveApproval: (toolCallId, decision) => {
      const resolve = waiters.get(toolCallId);
      if (!resolve) return false;
      waiters.delete(toolCallId);
      resolve(decision);
      return true;
    },
    resolveUserInput: () => false,
    abort: async () => false,
  };
  return { runtime, decisions };
}

test("the next approval is announced once even when it arrives while the reply is being sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-channel-"));
  const store = new ChannelStore(join(dir, "im-channels.json"));
  store.update("telegram", { access: "open", allowUsers: ["owner"], fields: { botToken: "secret-token" } });
  const fake = stagedRuntime();
  const bridge = new ChannelBridge({ platform: "telegram", runtime: fake.runtime, store, settings: () => store.get("telegram"),
    defaultPermissionMode: "request", onDenied: () => {} });
  const { sent, message } = chat();
  const prompts = (name: string) => sent.filter((text) => text.includes(`需要你的批准：${name}`)).length;
  try {
    await bridge.handle(message("write then bash"));
    await tick();
    assert.equal(prompts("write"), 1);
    // Answering t1 resolves its waiter, so t2 is emitted as a microtask — while the approval reply
    // is still in flight. The chat must be asked about bash exactly once, not twice.
    await bridge.handle(message("同意"));
    await tick();
    assert.match(sent.join("\n"), /已批准，继续执行。/);
    assert.equal(prompts("bash"), 1);
    await bridge.handle(message("同意"));
    await tick();
    assert.deepEqual({ ...fake.decisions }, { t1: "yes", t2: "yes" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a replayed hold never re-asks a tool that is waiting or already answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-channel-"));
  const store = new ChannelStore(join(dir, "im-channels.json"));
  store.update("telegram", { access: "open", allowUsers: ["owner"], fields: { botToken: "secret-token" } });
  let decide: ((decision: string) => void) | undefined;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const decisions: string[] = [];
  const runtime: ChannelRuntime = {
    configure: async () => ({}) as never,
    async runPrompt(input, onEvent) {
      const meta = { runId: input.requestId!, ts: 0, seq: 0, id: "e" };
      const emit = (type: string, payload: unknown) => onEvent({ ...meta, type, payload } as never);
      emit("tool.call.started", { toolCallId: "t1", name: "write", title: "write" });
      emit("tool.call.awaiting_approval", { toolCallId: "t1", argsPreview: { path: "a.md" } });
      // The same hold delivered twice while it is still unanswered.
      emit("tool.call.awaiting_approval", { toolCallId: "t1", argsPreview: { path: "a.md" } });
      await new Promise<void>((resolve) => { decide = (decision) => { decisions.push(decision); resolve(); }; });
      // And once more after the chat has already answered it: this must not queue anything.
      emit("tool.call.awaiting_approval", { toolCallId: "t1", argsPreview: { path: "a.md" } });
      emit("run.finished", { status: "success" });
      finished();
    },
    resolveApproval: (toolCallId, decision) => { if (toolCallId !== "t1" || !decide) return false; decide(decision); decide = undefined; return true; },
    resolveUserInput: () => false,
    abort: async () => false,
  };
  const bridge = new ChannelBridge({ platform: "telegram", runtime, store, settings: () => store.get("telegram"),
    defaultPermissionMode: "request", onDenied: () => {} });
  const { sent, message } = chat();
  const prompts = () => sent.filter((text) => text.includes("需要你的批准：write")).length;
  try {
    await bridge.handle(message("write"));
    await tick();
    assert.equal(prompts(), 1, "the duplicate while waiting is not announced twice");
    await bridge.handle(message("同意"));
    await done;
    await tick();
    assert.deepEqual(decisions, ["yes"]);
    assert.equal(prompts(), 1, "the hold replayed after the answer is not asked about again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two approvals in one turn are answered one at a time, and neither is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-channel-"));
  const store = new ChannelStore(join(dir, "im-channels.json"));
  store.update("telegram", { access: "open", allowUsers: ["owner"], fields: { botToken: "secret-token" } });
  const fake = parallelRuntime();
  // An explicit type, so an assertion below cannot narrow it to the keys asserted so far.
  const decisions: Record<string, string> = fake.decisions;
  const bridge = new ChannelBridge({ platform: "telegram", runtime: fake.runtime, store, settings: () => store.get("telegram"),
    defaultPermissionMode: "request", onDenied: () => {} });
  const { sent, message } = chat();
  try {
    await bridge.handle(message("do two things"));
    await tick();
    // The second approval must not replace the first: the chat is asked about one tool at a time.
    assert.equal(sent.filter((text) => /需要你的批准/.test(text)).length, 1);
    assert.match(sent.at(-1)!, /需要你的批准：write/);
    await bridge.handle(message("同意"));
    await tick();
    assert.deepEqual({ ...decisions }, { t1: "yes" }, "the first approval is the one answered");
    assert.ok(sent.some((text) => /需要你的批准：bash/.test(text)), "the second is asked once the first is answered");
    await bridge.handle(message("拒绝"));
    await tick();
    assert.deepEqual(Object.keys(decisions).sort(), ["t1", "t2"], "both tools were answered");
    assert.equal(decisions.t2, "no");
    assert.ok(!sent.some((text) => /上一个任务还在运行/.test(text)), "an approval reply is never mistaken for a busy chat");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("natural assistant messages are delivered separately, including platforms without editing", async () => {
  for (const streaming of [true, false]) {
    const state = setup();
    const c = chat();
    let finish!: () => void;
    state.runtime.runPrompt = async (input, onEvent) => {
      let seq = 0;
      const emit = (type: string, payload: unknown, messageId = "m1") => onEvent({ runId: input.requestId!, ts: 0, seq: ++seq, id: `e${seq}`, type, payload, messageId } as never);
      emit("text.started", { textId: "first", role: "assistant" });
      emit("text.delta", { textId: "first", delta: "我先核对原文。" });
      emit("text.finished", { textId: "first" });
      emit("tool.call.started", { toolCallId: "read", name: "web_fetch" });
      emit("text.started", { textId: "second", role: "assistant" }, "m2");
      emit("text.delta", { textId: "second", delta: "核对结果如下。" }, "m2");
      await new Promise<void>(resolve => { finish = resolve; });
      emit("run.finished", { status: "success" });
    };
    try {
      const message = c.message("check");
      if (!streaming) delete message.reply.stream;
      await state.bridge.handle(message);
      await tick();
      const first = streaming ? c.streamed : c.sent;
      assert.ok(first.includes(streaming ? "final:我先核对原文。" : "我先核对原文。"), "first message is delivered before the run ends");
      finish();
      await tick();
      assert.equal((streaming ? c.streamed : c.sent).at(-1), streaming ? "final:核对结果如下。" : "核对结果如下。");
      assert.ok(![...c.streamed, ...c.sent].some(text => text.includes("我先核对原文。") && text.includes("核对结果如下。")));
    } finally { finish?.(); state.cleanup(); }
  }
});
