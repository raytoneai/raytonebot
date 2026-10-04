import test from "node:test";
import assert from "node:assert/strict";
import { clearUserInputDraft, readUserInputDraft, writeUserInputDraft } from "./userInputDraft.ts";
import { userQuestions, type PendingUserInput } from "./userInput.ts";

const request: PendingUserInput = { requestId: "question-1", toolCallId: "tool-1", questions: userQuestions([
  { question: "Language?", options: [{ label: "中文" }, { label: "English" }] },
  { question: "Scope?", multiSelect: true, options: [{ label: "代码" }, { label: "交互" }] },
], "claude") };
function memory() {
  const records = new Map<string, string>();
  return { records, getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
}

test("question drafts recover all answers and progress without restoring submission flags or crossing identities", () => {
  const store = memory();
  const draft = { index: 1, choices: { q0: ["中文"], q1: ["代码", "交互"] }, other: { q0: "", q1: "保留组件" }, pending: true, done: true };
  assert.equal(writeUserInputDraft("conversation", request.requestId, draft, () => store), true);
  assert.deepEqual(readUserInputDraft("conversation", request, () => store), {
    draft: { index: 1, choices: draft.choices, other: draft.other }, saved: true,
  });
  assert.equal(JSON.stringify([...store.records.values()]).includes("pending"), false);
  assert.equal(readUserInputDraft("different", request, () => store).draft.index, 0);
  assert.equal(readUserInputDraft("conversation", { ...request, requestId: "next" }, () => store).draft.index, 0);
  writeUserInputDraft("conversation", "next", draft, () => store);
  clearUserInputDraft("conversation", request.requestId, () => store);
  assert.equal(store.records.size, 1, "late acknowledgement cannot delete the next draft");
  clearUserInputDraft("conversation", "next", () => store);
  assert.equal(store.records.size, 0);
});

test("corrupt, out-of-range and unavailable answer storage cannot bypass current questions or disable answering", () => {
  const store = memory();
  for (const draft of [
    { index: 5, choices: {}, other: {} },
    { index: 0, choices: { q0: ["invented"] }, other: {} },
    { index: 0, choices: { q0: ["中文", "English"] }, other: {} },
    { index: 0, choices: {}, other: { q0: "x".repeat(4001) } },
    { index: 0, choices: { q0: ["中文"] }, other: { q0: "also selected" } },
    { index: 0, choices: null, other: null },
  ]) {
    store.setItem("raytonebot-question-draft:conversation", JSON.stringify({ requestId: request.requestId, draft }));
    assert.deepEqual(readUserInputDraft("conversation", request, () => store), { draft: { index: 0, choices: {}, other: {} }, saved: false });
  }
  const unavailable = () => { throw new Error("Storage denied"); };
  assert.equal(readUserInputDraft("conversation", request, unavailable).saved, false);
  assert.equal(writeUserInputDraft("conversation", request.requestId, { index: 0, choices: {}, other: {} }, unavailable), false);
  assert.doesNotThrow(() => clearUserInputDraft("conversation", request.requestId, unavailable));
});
