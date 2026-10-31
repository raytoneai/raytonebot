import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "21a5f07";
const path = "src/agent-shell.tsx";
const parse = text => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }));
const after = parse(readFileSync(path, "utf8"));
const fields = ["groupHostId", "groupTyping", "welcomeGroup", "headerAgent", "composerMentions", "composerPlaceholder"];
function properties(source) {
  let shell;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "shellExtras") shell = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return shell.properties.filter(property => fields.includes(property.name?.getText()));
}
for (const property of properties(after)) {
  const original = properties(before).find(candidate => candidate.name.getText() === property.name.getText());
  const liveExpression = property.initializer.getText().replace(/^streamId \? undefined : /, "").replace(/^!streamId && /, "");
  assert.equal(liveExpression, original.initializer.getText());
}
function withoutFields(source) {
  let text = source.text;
  for (const property of properties(source).reverse()) {
    const node = property.initializer;
    text = text.slice(0, node.getStart()) + "undefined" + text.slice(node.end);
  }
  return ts.createPrinter({ removeComments: true }).printFile(parse(text));
}
assert.equal(withoutFields(after), withoutFields(before));
const result = { baseline, fields, liveExpressionsIdentical: true, remainingShellSyntaxIdentical: true };
writeFileSync(new URL("shell-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
