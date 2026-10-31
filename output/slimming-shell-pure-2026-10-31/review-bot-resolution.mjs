import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { knownBotsForConversations, resolveParticipantBot } from "../../src/runtime/botProfiles.ts";
import { DEFAULT_BOTS } from "../../src/runtime/botAppearance.ts";

const baseline = "14daa5a";
const path = "src/agent-shell.tsx";
const target = process.argv[2];
const readTarget = path => target ? execFileSync("git", ["show", `${target}:${path}`], { encoding: "utf8" }) : readFileSync(path, "utf8");
const parse = text => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }));
const after = parse(readTarget(path));
const printer = ts.createPrinter({ removeComments: true });
function nodes(source, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(source);
  return result;
}
const variable = (source, name) => nodes(source, n => ts.isVariableDeclaration(n) && n.name.getText() === name)[0].initializer;
const originalMerge = variable(before, "knownBots");
const originalResolver = variable(before, "presetBot");
assert.equal(variable(after, "knownBots").arguments[1].getText(), originalMerge.arguments[1].getText());
assert.equal(variable(after, "knownBots").arguments[0].getText(), "() => knownBotsForConversations(bots, piConversations)");
assert.equal(variable(after, "presetBot").getText(), "(id: string) => resolveParticipantBot(id, knownBots, bots, activePiConversation.groupParticipants)");
function withoutExtraction(source) {
  const replacements = source.statements.filter(ts.isImportDeclaration).map(n => [n.getStart(), n.end, ""]);
  for (const name of ["knownBots", "presetBot"]) {
    const node = variable(source, name);
    replacements.push([node.getStart(), node.end, "undefined"]);
  }
  let text = source.text;
  for (const [start, end, replacement] of replacements.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return printer.printFile(parse(text));
}
assert.equal(withoutExtraction(after), withoutExtraction(before));
const helper = parse(readTarget("src/runtime/botProfiles.ts"));
const body = name => nodes(helper, n => ts.isFunctionDeclaration(n) && n.name?.text === name)[0].body;
const printBody = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source);
assert.equal(printBody(body("knownBotsForConversations"), helper).replace(/\bconversations\b/g, "piConversations"), printBody(originalMerge.arguments[0].body, before));
assert.equal(printBody(body("resolveParticipantBot"), helper).replace(/\bparticipants\b/g, "activePiConversation.groupParticipants"), printBody(originalResolver.body, before));
const compile = expression => ts.transpile(`return (${expression});`, { target: ts.ScriptTarget.ES2022 });
const oldMerge = Function("bots", "piConversations", compile(`(${originalMerge.arguments[0].getText()})()`));
const oldResolve = Function("bots", "knownBots", "activePiConversation", compile(originalResolver.getText()));
const custom = "bot_01234567-89ab-cdef-0123-456789abcdef";
const configured = ["assistant", "planner", "builder"].map((id, i) => ({ id, presetId: id, name: `Current ${id}`, appearance: Object.values(DEFAULT_BOTS)[i], model: { provider: "test", model: id } }));
const botSets = [configured, [...configured].reverse(), configured.slice(1), [configured[1]], [], [{ ...configured[0], id: custom, name: "Custom configured" }, ...configured]];
const participantSets = [undefined, [], [{ id: "assistant", presetId: "assistant", name: "Old Raer" }],
  [{ id: custom, presetId: "planner", name: "Old custom" }, { id: custom, presetId: "builder", name: "Later duplicate" }],
  [{ id: "dsh", presetId: "dsh", name: "DSH history" }, { id: custom, presetId: "assistant", name: "Other custom" }]];
let mergeComparisons = 0;
let resolutionComparisons = 0;
for (const bots of botSets) for (const first of participantSets) for (const second of participantSets) {
  const conversations = [{ availableBots: first, groupParticipants: second }, { availableBots: second, groupParticipants: first }];
  const snapshot = structuredClone({ bots, conversations });
  const known = knownBotsForConversations(bots, conversations);
  assert.deepEqual(known, oldMerge(bots, conversations));
  bots.forEach((bot, i) => assert.equal(known[i], bot));
  mergeComparisons++;
  for (const participants of participantSets) for (const id of ["assistant", "planner", "builder", "dsh", custom, "missing"]) {
    const actual = resolveParticipantBot(id, known, bots, participants);
    const expected = oldResolve(bots, known, { groupParticipants: participants })(id);
    assert.deepEqual(actual, expected);
    if (known.includes(expected) || bots.includes(expected)) assert.equal(actual, expected);
    resolutionComparisons++;
  }
  assert.deepEqual({ bots, conversations }, snapshot);
}
const result = { baseline, mergeComparisons, resolutionComparisons, extractedBodiesIdentical: true, remainingShellSyntaxIdentical: true, activeBotAndStateMachinesUnchanged: true, memoDependenciesIdentical: true };
writeFileSync(new URL("bot-resolution-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
