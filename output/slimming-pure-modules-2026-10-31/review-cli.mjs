import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import ts from "typescript";
import * as config from "../../src/pi/cliHarnessConfig.ts";
import * as facade from "../../src/pi/cliHarness.ts";

const baseline = "f7793f7";
const path = "src/pi/cliHarness.ts";
const parse = text => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
const before = parse(execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }));
const after = parse(readFileSync(path, "utf8"));
const extracted = parse(readFileSync("src/pi/cliHarnessConfig.ts", "utf8"));
const moved = ["CLAUDE_PROVIDER_ENV_KEYS", "CODEX_COMMAND_ENV", "CLAUDE_ASK_TOOLS", "cliCommand", "CLAUDE_HOST_MCP", "buildClaudeArgs", "claudeSdkServers", "CLAUDE_PARENT_SESSION_ENV_KEYS", "claudeEnv", "CODEX_PROVIDER_KEY_ENV", "buildCodexArgs"];
const printer = ts.createPrinter({ removeComments: true });
const name = node => node.name?.getText() ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : undefined);
const print = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/^export /, "");
for (const id of moved) {
  assert.equal(print(extracted.statements.find(node => name(node) === id), extracted), print(before.statements.find(node => name(node) === id), before));
}
const remaining = source => source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) && !moved.includes(name(node))).map(node => print(node, source));
assert.deepEqual(remaining(after), remaining(before));
for (const id of ["buildClaudeArgs", "buildCodexArgs", "claudeEnv", "cliCommand", "CLAUDE_HOST_MCP", "CODEX_PROVIDER_KEY_ENV"]) assert.equal(facade[id], config[id]);
const originalText = before.statements.filter(node => moved.includes(name(node))).map(node => print(node, before)).join("\n");
const original = Function("homedir", ts.transpile(`${originalText}\nreturn { cliCommand, buildClaudeArgs, buildCodexArgs, claudeEnv, claudeSdkServers };`, { target: ts.ScriptTarget.ES2022 }))(homedir);
let comparisons = 0;
for (const provider of [undefined, { baseUrl: 'https://example.invalid/"quoted"', apiKey: "dummy-test-key", model: "test-model\\quoted", name: "Test provider" }]) {
  for (const permissionMode of ["request", "auto", "allow-all"]) for (const resumeId of [undefined, "old-session"]) for (const toolBits of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const options = { provider, permissionMode, resumeId, cwd: '/work/"quoted"', addDirs: ["/shared space"], forkAtMessageId: resumeId ? "old-message" : undefined,
      appendSystemPrompt: "Test instructions", disallowedTools: ["Edit"], webTools: toolBits & 1 ? {} : undefined,
      hostTools: toolBits & 2 ? {} : undefined, mcpTools: toolBits & 4 ? { servers: [{ id: "first" }, { id: "second" }] } : undefined };
    const snapshot = structuredClone(options);
    for (const id of ["buildClaudeArgs", "claudeSdkServers"]) { assert.deepEqual(config[id](options), original[id](options)); comparisons++; }
    for (const home of [undefined, '/private/home "quoted"']) { assert.deepEqual(config.buildCodexArgs(options, home), original.buildCodexArgs(options, home)); comparisons++; }
    assert.deepEqual(options, snapshot);
  }
  for (const base of [{}, { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_TASK_LIST_ID: "parent", ANTHROPIC_API_KEY: "dummy-inherited", ANTHROPIC_AUTH_TOKEN: "dummy-inherited-token", ANTHROPIC_MODEL: "old-model" }]) {
    const snapshot = structuredClone(base);
    assert.deepEqual(config.claudeEnv(base, provider), original.claudeEnv(base, provider));
    assert.deepEqual(base, snapshot); comparisons++;
  }
}
for (const harness of ["claude-code", "codex", "dsh"]) for (const env of [{}, { RAYTONEBOT_CLAUDE_BIN: " /claude ", RAYTONEBOT_CODEX_BIN: " /codex ", RAYTONEBOT_DSH_BIN: " /dsh " }, { RAYTONEBOT_CLAUDE_BIN: " ", RAYTONEBOT_CODEX_BIN: " ", RAYTONEBOT_DSH_BIN: " " }]) {
  assert.equal(config.cliCommand(harness, env), original.cliCommand(harness, env)); comparisons++;
}
const result = { baseline, movedDeclarations: moved.length, movedSyntaxIdentical: true, remainingHarnessSyntaxIdentical: true, publicExportsPreserved: true, comparisons };
writeFileSync(new URL("cli-review.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(result);
