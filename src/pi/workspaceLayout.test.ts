import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildClaudeArgs } from "./cliHarness.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { classifyToolCall, defaultProtectedPaths, defaultReadOnlyPaths } from "./permissionPolicy.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout, workspacePrompt } from "./workspaceLayout.ts";

test("without a root every role shares one directory and nothing is created", () => {
  const layout = resolveWorkspaceLayout({ fallbackCwd: "/app" });
  assert.deepEqual(Object.values(layout.agents), ["/app", "/app", "/app"]);
  assert.equal(layout.shared, undefined);
  assert.equal(workspacePrompt("planner", layout), undefined);
});

test("with a root: own directory per role, a shared one, briefs that are not overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-ws-"));
  try {
    const layout = resolveWorkspaceLayout({ fallbackCwd: "/app", root });
    assert.equal(layout.agents.builder, join(root, "agents", "builder"));
    assert.equal(layout.shared, join(root, "shared"));
    ensureWorkspaceLayout(layout);
    for (const dir of Object.values(layout.agents)) assert.ok(existsSync(join(dir, "AGENTS.md")));
    assert.match(readFileSync(join(layout.agents.assistant, "AGENTS.md"), "utf8"), /shared/);
    assert.ok(existsSync(join(layout.shared!, "README.md")));

    writeFileSync(join(layout.agents.planner, "AGENTS.md"), "edited");
    ensureWorkspaceLayout(layout);
    assert.equal(readFileSync(join(layout.agents.planner, "AGENTS.md"), "utf8"), "edited");

    assert.match(workspacePrompt("planner", layout) ?? "", new RegExp(layout.shared!.replace(/[/\\]/g, ".")));

    // The app's own code becomes read-only once agents work elsewhere; shared work does not.
    const workspaces = [...Object.values(layout.agents), layout.shared!];
    const protectedPaths = defaultProtectedPaths({ workspaces });
    const readOnlyPaths = defaultReadOnlyPaths({ appRoot: "/srv/raytonebot", workspaces });
    const policy = { cwd: layout.agents.builder, protectedPaths, readOnlyPaths };
    assert.equal(classifyToolCall("write", { path: "/srv/raytonebot/src/x.ts" }, policy), "protected");
    assert.equal(classifyToolCall("write", { path: join(layout.shared!, "plans/a.md") }, policy), "mutating");
    assert.equal(classifyToolCall("edit", { path: join(layout.shared!, ".codex/config.toml") }, policy), "protected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI harnesses retain the shared directory with Codex writes approved per operation", () => {
  assert.deepEqual(buildClaudeArgs({ permissionMode: "request", addDirs: ["/ws/shared"] }).slice(-2), ["--add-dir", "/ws/shared"]);
  const requests: Record<string, unknown>[] = [];
  const codex = createCodexAppServer({ cwd: "/ws/agents/builder", addDirs: ["/ws/shared"], resumeId: "t", prompt: "continue",
    signal: new AbortController().signal, emit() {}, onSessionId() {}, onPermission: async () => true });
  codex.push({ id: "initialize", result: {} }, (request) => requests.push(request));
  const params = requests.at(-1)?.params as Record<string, unknown>;
  assert.deepEqual(params.runtimeWorkspaceRoots, ["/ws/agents/builder", "/ws/shared"]);
  assert.equal(params.sandbox, "read-only", "shared writes still require an individual approval");
});
