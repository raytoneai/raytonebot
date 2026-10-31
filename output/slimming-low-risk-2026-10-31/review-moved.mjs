import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const [sourcePath, destinationPath, names, baseline = "2432baa"] = process.argv.slice(2);
if (!sourcePath || !destinationPath || !names) throw new Error("Expected source, destination and comma-separated declaration names");
const moved = names.split(",");
const parse = (path, content) => ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
const before = parse(sourcePath, execFileSync("git", ["show", `${baseline}:${sourcePath}`], { encoding: "utf8" }));
const after = parse(sourcePath, readFileSync(sourcePath, "utf8"));
const destination = parse(destinationPath, readFileSync(destinationPath, "utf8"));
const printer = ts.createPrinter({ removeComments: true });
const nameOf = node => node.name?.text ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.text : undefined);
const syntax = (node, file) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/^export /, "");
for (const name of moved) {
  const original = before.statements.find(node => nameOf(node) === name);
  const extracted = destination.statements.find(node => nameOf(node) === name);
  assert.ok(original && extracted, `Missing declaration: ${name}`);
  assert.equal(syntax(extracted, destination), syntax(original, before), `Changed declaration: ${name}`);
  assert.equal(after.statements.some(node => nameOf(node) === name), false, `Duplicate declaration: ${name}`);
}
const remaining = file => file.statements
  .filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) && !moved.includes(nameOf(node)))
  .map(node => syntax(node, file));
assert.deepEqual(remaining(after), remaining(before), "Unrelated implementation changed");
console.log(JSON.stringify({ baseline, sourcePath, destinationPath, movedDeclarations: moved,
  movedSyntaxIdentical: true, remainingDeclarations: remaining(after).length, remainingSyntaxIdentical: true }, null, 2));
