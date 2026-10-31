import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { toolAction, isRunningTool, toolFilePresentation } from "../../src/runtime/toolPresentation.ts";
import { buildToolDisplaySpec } from "../../src/runtime/toolDisplaySpec.ts";
import { chatCopy } from "../../src/i18n/copy/chat.ts";

const baseline = "2dee529";
const cardPath = "src/components/agent-preview/ToolCallCard.tsx";
const parse = (text, path = cardPath) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const before = parse(execFileSync("git", ["show", `${baseline}:${cardPath}`], { encoding: "utf8" }));
const after = parse(readFileSync(cardPath, "utf8"));
const target = parse(readFileSync("src/runtime/toolPresentation.ts", "utf8"), "toolPresentation.ts");
const printer = ts.createPrinter({ removeComments: true });
const name = node => node.name?.getText() ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : undefined);
const print = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/^export /, "");
const presentationBefore = parse(execFileSync("git", ["show", `${baseline}:src/runtime/toolPresentation.ts`], { encoding: "utf8" }), "toolPresentation.ts");
for (const node of presentationBefore.statements.filter(node => !ts.isImportDeclaration(node))) {
  assert.equal(print(target.statements.find(candidate => name(candidate) === name(node)), target), print(node, presentationBefore));
}
const moved = ["ToolFileAction", "ToolFileReference", "toolActionPreview", "ToolTitleParts", "FILE_TOKEN_PATTERN", "resolveToolFileAction", "fileActionRowLabel", "buildToolFileReferences", "ExplicitImageFileReference", "explicitImageFileReferences", "languageFromFileName", "splitToolTitle", "pathFromTool", "toRecord", "tryParseRecord", "getString"];
for (const id of moved) {
  assert.equal(print(target.statements.find(node => name(node) === id), target).replace(/\btoolAction\(/g, "resolveToolAction("), print(before.statements.find(node => name(node) === id), before));
}
const unchanged = before.statements.filter(node => ts.isFunctionDeclaration(node) && !moved.includes(name(node)) && !["ToolCallCard", "outputPanelItemsFromTool"].includes(name(node)));
for (const node of unchanged) assert.equal(print(after.statements.find(candidate => name(candidate) === name(node)), after), print(node, before));
const card = source => source.statements.find(node => name(node) === "ToolCallCard");
const projectionNames = ["titleParts", "toolAction", "fileAction", "fileReferences", "filePresentation", "headerPreview"];
const rendering = source => card(source).body.statements.filter(node => !ts.isVariableStatement(node) || !projectionNames.includes(name(node))).map(node => print(node, source));
assert.deepEqual(rendering(after), rendering(before));
const previewFallback = source => card(source).body.statements.find(node => name(node) === "headerPreview").declarationList.declarations[0].initializer.whenFalse;
assert.equal(print(previewFallback(after), after), print(previewFallback(before), before));
const functions = before.statements.filter(node => moved.includes(name(node))).map(node => print(node, before)).join("\n");
const original = Function("resolveToolAction", "isRunningTool", "buildToolDisplaySpec", "chatCopy", ts.transpile(`${functions}
  return (tool, locale) => {
    const titleParts = splitToolTitle(tool.title ?? tool.name, pathFromTool(tool));
    const action = resolveToolAction(tool);
    const fileAction = resolveToolFileAction(tool, titleParts);
    return { action, fileReferences: fileAction ? buildToolFileReferences(tool, fileAction, locale, titleParts) : [],
      actionPreview: action ? toolActionPreview(tool, action) : undefined };
  };`, { target: ts.ScriptTarget.ES2022 }))(toolAction, isRunningTool, buildToolDisplaySpec, chatCopy);
const panelCode = source => print(source.statements.find(node => name(node) === "outputPanelItemsFromTool"), source);
const oldPanel = Function("resolveToolAction", "isRunningTool", "buildToolDisplaySpec", "chatCopy", ts.transpile(`${functions}\n${panelCode(before)}\nreturn outputPanelItemsFromTool;`, { target: ts.ScriptTarget.ES2022 }))(toolAction, isRunningTool, buildToolDisplaySpec, chatCopy);
const newPanel = Function("toolFilePresentation", ts.transpile(`${panelCode(after)}\nreturn outputPanelItemsFromTool;`, { target: ts.ScriptTarget.ES2022 }))(toolFilePresentation);
const argsCases = [{}, { args: { path: "src/example.tsx", content: "INPUT", oldText: "old", newText: "new", command: "echo test", pattern: "test" } },
  { args: { file: "data/report.json" } }, { argsText: '{"filename":"file.py","cmd":"run","query":"text"}' }, { argsText: '{"path":', approval: { argsPreview: { path: "approved.md", content: "approved" } } },
  { args: [], argsText: '{"path":"notes.md"}' }];
const results = [undefined, "RESULT", { content: [{ type: "text", text: "RESULT BODY" }] }, { images: [{ path: "first.png", src: "data:image/png;base64,AA==" }, { file: "second.png", dataUrl: "data:image/png;base64,AQ==", meta: "exact" }] },
  { images: [null, [], { name: "third.jpeg", uri: "image-uri" }, { path: "fourth.svg", imageSrc: "image-source" }, { path: "" }] }];
let comparisons = 0;
for (const name of ["read", "read_image", "write", "modify_file", "edit", "bash", "run_tests", "search", "unknown_tool"])
  for (const status of ["pending", "args_streaming", "awaiting_approval", "running", "success", "error", "cancelled"])
    for (const args of argsCases) for (const result of results) for (const locale of ["en", "zh", "ja"]) {
      const tool = { kind: "tool", id: "review", name, status, title: comparisons % 2 ? "Read nested/fallback.md suffix" : "", preview: "Backend summary", ...args, result };
      const snapshot = structuredClone(tool);
      assert.deepEqual(toolFilePresentation(tool, locale), original(tool, locale));
      assert.deepEqual(newPanel(tool, locale), oldPanel(tool, locale));
      assert.deepEqual(tool, snapshot);
      comparisons++;
    }
const result = { baseline, movedDeclarations: moved.length, movedSyntaxIdenticalExceptActionReference: true, existingPresentationUnchanged: true, unchangedRenderingHelpers: unchanged.length, cardHooksHandlersAndJsxIdentical: true, previewFallbackIdentical: true, projectionComparisons: comparisons, publicPanelComparisons: comparisons, inputUnchanged: true };
writeFileSync(new URL("tools-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
