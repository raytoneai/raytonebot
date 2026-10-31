import assert from "node:assert/strict";
import test from "node:test";
import { codexTool, codexToolOutput } from "./cliToolNormalization.ts";

test("Codex file changes distinguish a single add from edits and preserve change output", () => {
  const changes = [{ kind: "add", path: "new.ts" }];
  const input = { changes };
  const before = structuredClone(input);

  assert.deepEqual(codexTool("file_change", input), {
    name: "write",
    args: { path: "new.ts", changes },
  });
  assert.equal(codexToolOutput("file_change", input), "add new.ts");
  assert.deepEqual(input, before);
  assert.equal(codexTool("file_change", { changes: [...changes, { kind: "update", path: "other.ts" }] })?.name, "edit");
  assert.equal(codexTool("file_change", { changes: [] })?.name, "edit");
  assert.equal(codexToolOutput("file_change", { changes: [] }), "");
  assert.deepEqual(codexTool("file_change", { changes: [null] }), { name: "edit", args: { changes: [{}] } });
  assert.equal(codexToolOutput("file_change", { changes: [null] }), "update ");
});

test("Codex command execution unwraps the displayed command and returns aggregated output", () => {
  const input = { command: "/bin/zsh -lc 'npm test'", aggregated_output: "ok\n" };
  const before = structuredClone(input);

  assert.deepEqual(codexTool("command_execution", input), { name: "bash", args: { command: "npm test" } });
  assert.equal(codexToolOutput("command_execution", input), "ok\n");
  assert.deepEqual(input, before);
});

test("Codex MCP calls retain names and arguments; output prefers errors and serializes JSON results", () => {
  const input = { server: "raytone", tool: "remember", arguments: { key: "k", value: "v" }, result: { saved: true } };
  const before = structuredClone(input);

  assert.deepEqual(codexTool("mcp_tool_call", input), {
    name: "raytone.remember",
    args: { key: "k", value: "v" },
  });
  assert.equal(codexToolOutput("mcp_tool_call", input), JSON.stringify(input.result));
  assert.deepEqual(input, before);
  assert.deepEqual(codexTool("mcp_tool_call", { arguments: null })?.args, {});
  assert.equal(codexTool("mcp_tool_call", { arguments: null })?.name, "mcp");
  assert.equal(codexToolOutput("mcp_tool_call", { error: "failed", result: { ignored: true } }), "failed");
  assert.equal(codexToolOutput("mcp_tool_call", { error: { code: 2 } }), '{"code":2}');
  assert.equal(codexToolOutput("mcp_tool_call", { result: { saved: true } }), '{"saved":true}');
});
