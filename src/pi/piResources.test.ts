import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as pi from "@earendil-works/pi-coding-agent";

import { createHostResources } from "./piResources.ts";

/** An extension that leaves a marker file when Pi loads it. */
function plantExtension(path: string, marker: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default function () {}\n`);
}

test("agent-writable .pi files and global extensions never load into the host", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-resources-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# workspace rules\n");
    const markers = { project: join(root, "project-ext"), settings: join(root, "settings-ext"), global: join(root, "global-ext") };
    plantExtension(join(cwd, ".pi", "extensions", "evil.ts"), markers.project);
    plantExtension(join(cwd, ".pi", "other.ts"), markers.settings);
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["other.ts"] }));
    plantExtension(join(agentDir, "extensions", "evil.ts"), markers.global);

    // Control: Pi's defaults (what createAgentSession used without a loader) do load them.
    const unsafe = new pi.DefaultResourceLoader({ cwd, agentDir });
    await unsafe.reload();
    assert.equal(unsafe.getExtensions().extensions.length, 3);
    for (const [name, marker] of Object.entries(markers)) assert.ok(existsSync(marker), `${name} extension loads by default`);
    for (const marker of Object.values(markers)) rmSync(marker, { force: true });

    const { settingsManager, resourceLoader } = await createHostResources(pi, cwd);
    assert.equal(resourceLoader.getExtensions().extensions.length, 0);
    for (const [name, marker] of Object.entries(markers)) assert.ok(!existsSync(marker), `${name} extension code ran`);
    assert.equal(settingsManager.isProjectTrusted(), false);
    assert.ok(
      resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md")),
      "workspace AGENTS.md still reaches the agent",
    );
    assert.deepEqual(resourceLoader.getSkills().skills, [], "the developer's own skills never reach a product agent");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox resources cannot follow workspace symlinks into bot-private context", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-resource-links-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSandbox = process.env.RAYTONEBOT_SANDBOX;
  try {
    const cwd = join(root, "workspace"), agentDir = join(root, "agent"), privateFile = join(root, "bot-private");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.RAYTONEBOT_SANDBOX = "1";
    mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(privateFile, "PRIVATE_CONTEXT_SENTINEL");
    symlinkSync(privateFile, join(cwd, "AGENTS.md"));
    symlinkSync(privateFile, join(cwd, ".pi", "SYSTEM.md"));
    symlinkSync(privateFile, join(cwd, ".pi", "APPEND_SYSTEM.md"));
    symlinkSync(privateFile, join(cwd, ".pi", "prompts", "leak.md"));
    const { resourceLoader } = await createHostResources(pi, cwd);
    assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(resourceLoader.getSkills().skills, []);
    assert.deepEqual(resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(resourceLoader.getThemes().themes, []);
    assert.equal(resourceLoader.getSystemPrompt(), undefined);
    assert.deepEqual(resourceLoader.getAppendSystemPrompt(), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSandbox === undefined) delete process.env.RAYTONEBOT_SANDBOX; else process.env.RAYTONEBOT_SANDBOX = previousSandbox;
    rmSync(root, { recursive: true, force: true });
  }
});
