import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real shell handler with controlled async completion and React state setters.
const source = ts.createSourceFile('agent-shell.tsx', readFileSync(new URL('../../src/agent-shell.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'openStoredConversation') handler = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(handler);
const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const lateResult of ['success', 'failure']) {
  let resolveList, rejectList;
  const pending = new Promise((resolve, reject) => { resolveList = resolve; rejectList = reject; });
  const state = { pendingOpen: 'stale', pendingSource: undefined, failed: false, conversations: [{ id: 'current' }] };
  const navigationRequest = { current: 0 };
  const context = vm.createContext({
    navigationRequest,
    activePiConversationId: 'current', activePiConversation: { id: 'current' }, streamId: '',
    piConversations: state.conversations,
    setSettingsOpen() {}, setSourceNotice() {},
    setPendingSource(value) { state.pendingSource = value; },
    setPendingOpen(value) { state.pendingOpen = value; },
    setHistoryListFailed(value) { state.failed = value; },
    setPiConversations(update) { state.conversations = update(state.conversations); },
    refreshPiConversation() { return Promise.resolve(); },
    listStoredConversations() { return pending; },
    storedStub(entry) { return entry; },
    followRun() {},
    selectPiConversation() { throw new Error('Unexpected known-chat branch'); },
  });
  vm.runInContext(code, context);
  context.openStoredConversation('older', { artifactId: 'older-file' });
  context.openStoredConversation('current', { artifactId: 'latest-file' });
  if (lateResult === 'success') resolveList({ conversations: [{ id: 'older' }] });
  else rejectList(new Error('Delayed old request failed'));
  await pending.catch(() => {});
  await Promise.resolve();
  assert.equal(state.pendingOpen, undefined, `${lateResult}: an older navigation must not replace the latest selection`);
  assert.equal(state.pendingSource?.conversationId, 'current');
  assert.equal(state.pendingSource?.artifactId, 'latest-file');
  assert.equal(state.failed, false, 'a stale failure must not clear the latest target or show an error');
  assert.equal(state.conversations.length, 1, 'a stale response must not mutate the conversation list');
  console.log(`PASS: delayed ${lateResult} preserves the latest current-chat target`);
}
