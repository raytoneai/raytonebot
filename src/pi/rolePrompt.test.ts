import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCodexAppServer } from "./codexAppServer.ts";
import { classifyToolCall, defaultProtectedPaths, defaultReadOnlyPaths } from "./permissionPolicy.ts";
import { DEFAULT_SOULS, LEGACY_SOULS, PERSONA_FILE_LIMIT, personaFile, rolePrompt } from "./rolePrompt.ts";
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
    assert.match(raer, /use it only for handoffs/);
    assert.match(raer, /Reply language: the one named in the turn's language note/);
    assert.match(raer, /ASD-STE100/);
    assert.match(raer, /SOUL\.md \(your character\)\n# Raer/);
    assert.doesNotMatch(raer, /USER\.md \(user preferences\)/, "the seeded USER.md holds only a comment, so nothing is sent");
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
    writeFileSync(join(layout.agents.assistant, "SOUL.md"), LEGACY_SOULS.assistant[0]);
    ensureWorkspaceLayout(layout);
    assert.match(readFileSync(join(layout.agents.assistant, "AGENTS.md"), "utf8"), /handoffs, plans, other agents' work only/);
    assert.match(readFileSync(join(layout.agents.planner, "AGENTS.md"), "utf8"), /my note/);
    assert.equal(readFileSync(join(layout.agents.planner, "SOUL.md"), "utf8"), "# Tonny\n\nmine");
    assert.equal(readFileSync(join(layout.agents.assistant, "SOUL.md"), "utf8"), DEFAULT_SOULS.assistant, "an untouched earlier default is updated");
  } finally { cleanup(); }
});

test("agents read persona files freely but must ask before rewriting them", () => {
  const { layout, cleanup } = workspace();
  try {
    const workspaces = [...Object.values(layout.agents), layout.shared!];
    const policy = { cwd: layout.agents.assistant, protectedPaths: defaultProtectedPaths({ workspaces }),
      readOnlyPaths: defaultReadOnlyPaths({ appRoot: "/srv/raytonebot", workspaces }) };
    assert.equal(classifyToolCall("read", { path: join(layout.shared!, "USER.md") }, policy), "read");
    assert.equal(classifyToolCall("bash", { command: "cat SOUL.md" }, policy), "mutating", "a read-only shell command is ordinary work");
    assert.equal(classifyToolCall("write", { path: "SOUL.md" }, policy), "protected");
    assert.equal(classifyToolCall("edit", { path: join(layout.shared!, "USER.md") }, policy), "protected");
    assert.equal(classifyToolCall("bash", { command: "echo hi > SOUL.md" }, policy), "protected");
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

test("every role carries the product FAQ, with the settings page's own IM setup steps and the real deployment", async () => {
  const { settingsCopy } = await import("../i18n/copy/settings.ts");
  const { layout, cleanup } = workspace();
  try {
    const local = rolePrompt("planner", layout);
    assert.match(local, /RaytoneBot facts/);
    assert.ok(local.includes(settingsCopy.en.channels.setup.feishu), "Feishu steps come from the settings copy");
    assert.match(local, /owner's computer/);
    assert.match(local, /设置 → IM 频道/, "menu names match the UI");
    assert.ok(local.includes(layout.agents.planner));
    const cloud = rolePrompt("builder", layout, { sandboxed: true });
    assert.match(cloud, /cloud sandbox/);
    assert.match(cloud, /separate Linux user/);
  } finally { cleanup(); }
});

test("the interface language reaches the model as a per-turn note, never the saved transcript", async () => {
  const { createPiRuntimeController } = await import("./piHost.ts");
  const dir = mkdtempSync(join(tmpdir(), "rtb-lang-"));
  const seen: string[] = [];
  const controller = createPiRuntimeController({ cwd: dir, dataDir: dir, bridgeFactory: async () => ({
    subscribe: () => () => undefined, async prompt(text) { seen.push(text); }, abort: async () => undefined, dispose: () => undefined,
    configure: async () => undefined, state: async () => ({ models: [], tools: [] }) as never, newSession: async () => undefined,
  }) });
  try {
    await controller.runPrompt({ conversationId: "c", requestId: "r1", prompt: "run ls -la and explain", locale: "zh" }, () => {});
    await controller.runPrompt({ conversationId: "c", requestId: "r2", prompt: "hello" }, () => {});
    assert.match(seen[0], /reply in Simplified Chinese \(简体中文\), the user's interface language/);
    assert.equal(seen[1], "hello", "IM turns carry no interface language");
    assert.doesNotMatch(JSON.stringify(controller.getConversation("c")), /Language note/);
    assert.match(rolePrompt("assistant", resolveWorkspaceLayout({ fallbackCwd: dir })), /without a note, the language of the user's latest message/);
  } finally {
    controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
