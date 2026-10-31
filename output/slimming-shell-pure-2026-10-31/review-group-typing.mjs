import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { groupTypingMember } from "../../src/runtime/groupConversationView.ts";
import { isGroupConversation } from "../../src/pi/piConversationState.ts";
import { validParticipantId } from "../../src/pi/groupParticipants.ts";

const baseline = "fddcaae";
const path = "src/agent-shell.tsx";
const parse = text => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }));
const target = process.argv[2];
const readTarget = path => target ? execFileSync("git", ["show", `${target}:${path}`], { encoding: "utf8" }) : readFileSync(path, "utf8");
const after = parse(readTarget(path));
const printer = ts.createPrinter({ removeComments: true });
function nodes(source, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(source);
  return result;
}
const variable = (source, name) => nodes(source, n => ts.isVariableDeclaration(n) && n.name.getText() === name)[0].initializer;
const original = variable(before, "groupTyping");
const current = variable(after, "groupTyping");
assert.equal(current.arguments[1].getText(), original.arguments[1].getText());
assert.equal(current.arguments[0].getText(), "() => groupTypingMember(activePiConversation, events)");
function withoutExtraction(source) {
  const replacements = source.statements.filter(ts.isImportDeclaration).map(n => [n.getStart(), n.end, ""]);
  const node = variable(source, "groupTyping");
  replacements.push([node.getStart(), node.end, "undefined"]);
  let text = source.text;
  for (const [start, end, replacement] of replacements.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return printer.printFile(parse(text));
}
assert.equal(withoutExtraction(after), withoutExtraction(before));
const helper = parse(readTarget("src/runtime/groupConversationView.ts"));
const extracted = nodes(helper, n => ts.isFunctionDeclaration(n) && n.name?.text === "groupTypingMember")[0];
const printBody = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source);
assert.equal(printBody(extracted.body, helper).replace(/\bconversation\b/g, "activePiConversation"), printBody(original.arguments[0].body, before));
const js = ts.transpile(`return (${original.arguments[0].getText()})();`, { target: ts.ScriptTarget.ES2022 });
const old = Function("activePiConversation", "events", "isGroupConversation", "validParticipantId", js);
const member = "bot_01234567-89ab-cdef-0123-456789abcdef";
const start = id => ({ type: "group.member.started", payload: { member: id } });
const cases = [[], [start(member)], [start("invalid")], [start("assistant"), { type: "group.member.started", payload: null }]];
for (const pending of ["assistant", member]) {
  for (const type of ["text.started", "text.delta", "reasoning.started", "tool.call.running", "artifact.delta", "custom.event", "run.started", "run.finished", "run.error"]) {
    for (const key of ["messageId", "toolCallId", "textId", "reasoningId", "artifactId"]) {
      for (const id of [`${pending}~x`, `${pending}x`, "planner~x", "", undefined, 42]) {
        const output = { type, payload: key === "messageId" ? {} : { [key]: id }, ...(key === "messageId" ? { messageId: id } : {}) };
        cases.push([start(pending), output], [start("planner"), start(pending), output], [start(pending), output, start("planner")]);
      }
    }
  }
}
let comparisons = 0;
for (const shape of [{ id: "group_test" }, { id: "ordinary", groupMembers: ["assistant"] }, { id: "ordinary", groupMembers: [] }, { id: "ordinary" }]) {
  const conversation = { title: "Test", createdAt: 0, events: [], ...shape };
  for (const events of cases) {
    const snapshot = structuredClone(events);
    assert.equal(groupTypingMember(conversation, events), old(conversation, events, isGroupConversation, validParticipantId));
    assert.deepEqual(events, snapshot);
    comparisons++;
  }
}
const result = { baseline, comparisons, extractedBodyIdentical: true, remainingShellSyntaxIdentical: true, memoDependenciesIdentical: true };
writeFileSync(new URL("group-typing-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
