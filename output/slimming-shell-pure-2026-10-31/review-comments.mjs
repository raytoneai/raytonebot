import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "e3bd402";
const path = "src/agent-shell.tsx";
const target = process.argv[2];
const before = execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
const after = target
  ? execFileSync("git", ["show", `${target}:${path}`], { encoding: "utf8" })
  : readFileSync(path, "utf8");
const compile = source => {
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      removeComments: true,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  return result.outputText;
};
const compiled = compile(before);
assert.equal(compile(after), compiled);
const directiveLines = source => source.split("\n").filter(line => /@ts-|eslint-|@vite-|@jsx|#__PURE__|@__PURE__|sourceMappingURL|reference\s+(?:path|types)/.test(line));
assert.deepEqual(directiveLines(after), directiveLines(before));
const lines = source => source.split("\n").length - Number(source.endsWith("\n"));
const result = {
  baseline,
  emittedJavaScriptIdentical: true,
  compilerDirectivesIdentical: true,
  emittedJavaScriptSha256: createHash("sha256").update(compiled).digest("hex"),
  linesBefore: lines(before),
  linesAfter: lines(after),
};
writeFileSync(new URL("comments-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
