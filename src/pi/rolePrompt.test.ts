import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCodexAppServer } from "./codexAppServer.ts";
import { classifyToolCall, defaultProtectedPaths } from "./permissionPolicy.ts";
import { PERSONA_FILE_LIMIT, personaFile, rolePrompt } from "./rolePrompt.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rtb-role-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: "/app", root });
  return { root, layout, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("each role is named, told when the shared directory matters, and gets its own soul plus the shared user file", () => {
  const { layout, cleanup } = workspace();
  try {
    ensureWorkspaceLayout(layout);
    const raer = rolePrompt("assistant", layout);
    assert.match(raer, /You are Raer/);
    assert.match(raer, /only when the task mentions a handoff/);
    assert.match(raer, /Reply in the user's language/);
    assert.match(raer, /ASD-STE100/);
    assert.match(raer, /SOUL\.md\)\n\n# Raer/);
    assert.doesNotMatch(raer, /About the user/, "the seeded USER.md holds only a comment, so nothing is sent");
    assert.match(rolePrompt("builder", layout), /You are Bob[\s\S]*# Bob/);

    writeFileSync(join(layout.shared!, "USER.md"), "# About the user\n\n- Prefer Chinese replies.\n<!-- private note -->\n");
    writeFileSync(join(layout.agents.planner, "SOUL.md"), "x".repeat(PERSONA_FILE_LIMIT + 50));
    const tonny = rolePrompt("planner", layout);
    assert.match(tonny, /Prefer Chinese replies/);
    assert.doesNotMatch(tonny, /private note/);
    assert.match(tonny, /\[Truncated at 4096 characters\.\]/);
    assert.match(rolePrompt("assistant", layout), /Prefer Chinese replies/, "USER.md is shared by every role");
  } finally { cleanup(); }
});

test("persona files never follow a link to data the agent could not read itself", () => {
  const { root, layout, cleanup } = workspace();
  try {
    ensureWorkspaceLayout(layout);
    const secret = join(root, "bot-private");
    writeFileSync(secret, "PRIVATE_SENTINEL");
    const soul = join(layout.agents.assistant, "SOUL.md");
    rmSync(soul);
    symlinkSync(secret, soul);
    assert.equal(personaFile(soul), undefined);
    rmSync(soul);
    linkSync(secret, soul);
    assert.equal(personaFile(soul), undefined, "a hard link to another file is refused too");
    assert.doesNotMatch(rolePrompt("assistant", layout), /PRIVATE_SENTINEL/);
  } finally { cleanup(); }
});

test("an untouched old brief is updated, an edited one and edited souls are kept", () => {
  const { layout, cleanup } = workspace();
  try {
    mkdirSync(layout.agents.assistant, { recursive: true });
    mkdirSync(layout.agents.planner, { recursive: true });
    const legacy = `# Workspace (assistant)

This directory is your own working directory in RaytoneBot.

- Shared with every agent: \`${layout.shared}\`. Read it for handoffs from the other agents;
  put plans, results and files meant for them there.
- Other agents' directories: \`${layout.agents.planner}\` (planner), \`${layout.agents.builder}\` (builder). Do not change them.
- Suggested handoff names in the shared directory: \`plans/<topic>.md\`, \`handoffs/<from>-to-<to>.md\`, \`artifacts/\`.
`;
    writeFileSync(join(layout.agents.assistant, "AGENTS.md"), legacy);
    writeFileSync(join(layout.agents.planner, "AGENTS.md"), `${legacy}\nmy note\n`);
    writeFileSync(join(layout.agents.planner, "SOUL.md"), "# Tonny\n\nmine");
    ensureWorkspaceLayout(layout);
    assert.match(readFileSync(join(layout.agents.assistant, "AGENTS.md"), "utf8"), /Look there only when a task mentions a handoff/);
    assert.match(readFileSync(join(layout.agents.planner, "AGENTS.md"), "utf8"), /my note/);
    assert.equal(readFileSync(join(layout.agents.planner, "SOUL.md"), "utf8"), "# Tonny\n\nmine");
  } finally { cleanup(); }
});

test("agents must ask before rewriting persona files", () => {
  const { layout, cleanup } = workspace();
  try {
    const protectedPaths = defaultProtectedPaths({ workspaces: [...Object.values(layout.agents), layout.shared!] });
    const policy = { cwd: layout.agents.assistant, protectedPaths };
    assert.equal(classifyToolCall("write", { path: "SOUL.md" }, policy), "protected");
    assert.equal(classifyToolCall("edit", { path: join(layout.shared!, "USER.md") }, policy), "protected");
  } finally { cleanup(); }
});

test("Codex receives the role as developer instructions on resume, not inside the user's prompt", () => {
  const requests: Record<string, unknown>[] = [];
  const codex = createCodexAppServer({ cwd: "/ws/agents/builder", resumeId: "t", prompt: "continue", developerInstructions: "You are Bob.",
    signal: new AbortController().signal, emit() {}, onSessionId() {}, onPermission: async () => true });
  codex.push({ id: "initialize", result: {} }, (request) => requests.push(request));
  const thread = requests.at(-1)!;
  assert.equal(thread.method, "thread/resume");
  assert.equal((thread.params as Record<string, unknown>).developerInstructions, "You are Bob.");
  codex.push({ id: "thread", result: { thread: { id: "t" } } }, (request) => requests.push(request));
  assert.deepEqual((requests.at(-1)!.params as { input: { text: string }[] }).input[0].text, "continue");
});
