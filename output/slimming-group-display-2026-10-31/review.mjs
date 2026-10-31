// Compare the extracted functions with the actual pre-change shell expressions.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { groupConversationTitle, groupConversationPreviews, groupConversationFaces, groupMembersOf } from "../../src/runtime/groupConversationView.ts";
import { isGroupConversation } from "../../src/pi/piConversationState.ts";
import { groupRosterTitle, isGroupRosterTitle } from "../../src/i18n/copy/features.ts";
import { DEFAULT_BOT_NAMES as BOT_NAMES } from "../../src/pi/harnessCatalog.ts";

const baseline = "a097103";
const path = "src/agent-shell.tsx";
const parse = text => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }));
const after = parse(readFileSync(path, "utf8"));
function nodes(source, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(source);
  return result;
}
const functions = source => new Map(nodes(source, n => ts.isFunctionDeclaration(n) && n.name?.text !== "AgentApp").map(n => [n.name.text, n.getText()]));
assert.deepEqual(functions(after), functions(before));
const hooks = source => nodes(source, n => ts.isCallExpression(n) && ["useEffect", "useMemo", "useCallback"].includes(n.expression.getText())).map(n => n.getText());
assert.deepEqual(hooks(after), hooks(before));
const variable = (source, name) => nodes(source, n => ts.isVariableDeclaration(n) && n.name.getText() === name)[0].initializer.getText();
for (const name of ["knownBots", "activeBot", "presetBot"]) assert.equal(variable(after, name), variable(before, name));
const property = (source, name) => nodes(source, n => ts.isPropertyAssignment(n) && n.name.getText() === name)[0].initializer.getText();
for (const name of ["welcomeGroup", "headerAgent", "composerMentions"]) assert.equal(property(after, name), property(before, name));
function evaluate(expression, context) {
  const js = ts.transpile(`return (${expression});`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
  return Function(...Object.keys(context), js)(...Object.values(context));
}
const custom = "bot_01234567-89ab-cdef-0123-456789abcdef";
const avatarMap = { assistant: "woman", planner: "man", builder: "boy", dsh: "woman" };
let titleComparisons = 0;
let mappingComparisons = 0;
for (const renamed of [false, true]) {
  const bots = Object.entries(BOT_NAMES).map(([id, name]) => ({ id, presetId: id, name: renamed ? `${name} renamed` : name }));
  const entries = [];
  for (const members of [undefined, [], ["invalid"], ["assistant", "planner"], [custom, "builder", custom], ["dsh", "assistant"]]) {
    for (const saved of [false, true]) {
      for (const idPrefix of ["group_", "ordinary_"]) {
        for (const protection of [{}, { titleSource: "user" }, { titleSource: "summary" }, { groupTitlePreserved: true }, { groupTitlePreserved: false }]) {
          for (const title of ["Me, Raer, Tonny", "我、Raer、Tonny", "自分、Raer、Tonny", "Me, Raer renamed, Tonny renamed", "Project notes", `Me, ${custom}, Bob, ${custom}`]) {
            entries.push({ id: `${idPrefix}${entries.length}`, title, createdAt: 0, events: [], groupMembers: members, ...protection,
              ...(saved ? { groupParticipants: [{ id: custom, name: "Historical custom", presetId: "planner" }, { id: "assistant", name: "Historical Raer", presetId: "assistant" }] } : {}),
              ...(entries.length % 3 ? { groupPreview: { author: "assistant", text: entries.length % 2 ? "  first\n\t second  " : "   " } } : {}),
            });
          }
        }
      }
    }
  }
  const inputBefore = structuredClone(entries);
  // Use the unchanged shell resolver, including its cross-conversation catalog behavior.
  const knownBots = [...bots];
  for (const participant of entries.flatMap(c => [...c.availableBots ?? [], ...c.groupParticipants ?? []])) {
    if (!knownBots.some(bot => bot.id === participant.id)) knownBots.push({ ...(bots.find(bot => bot.presetId === participant.presetId) ?? bots[0]), ...participant });
  }
  const presetBot = evaluate(variable(before, "presetBot"), { knownBots, bots, activePiConversation: entries[0] });
  for (const locale of ["en", "zh", "ja"]) {
    const title = evaluate(variable(before, "conversationTitle"), { bots, presetBot, locale, groupMembersOf, isGroupConversation, BOT_NAMES, groupRosterTitle, isGroupRosterTitle });
    for (const entry of entries) {
      assert.equal(groupConversationTitle(entry, locale, bots, id => BOT_NAMES[presetBot(id).presetId]), title(entry));
      titleComparisons++;
    }
  }
  const context = { piConversations: entries, presetBot, groupMembersOf, isGroupConversation, BOT_NAMES, isGroupRosterTitle, PRESET_AVATARS: avatarMap };
  assert.deepEqual(groupConversationPreviews(entries, id => presetBot(id).name, id => BOT_NAMES[presetBot(id).presetId]), evaluate(property(before, "groupPreviews"), context));
  assert.deepEqual(groupConversationFaces(entries, avatarMap, id => presetBot(id).presetId), evaluate(property(before, "groupFaces"), context));
  assert.deepEqual(entries, inputBefore);
  mappingComparisons += entries.length * 2;
}
const result = { baseline, retainedFunctionsIdentical: [...functions(before).keys()], unchangedHookCalls: hooks(before).length,
  unchangedIdentityResolvers: ["knownBots", "activeBot", "presetBot"], unchangedUIProps: ["welcomeGroup", "headerAgent", "composerMentions"], titleComparisons, mappingComparisons, inputsUnchanged: true };
writeFileSync(new URL("review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
