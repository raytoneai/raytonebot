// Controlled existing-file workflow; this does not prove that a model follows the Skill.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotSkillsService } from "../../src/pi/botSkills.ts";
import { ArtifactVersionStore } from "../../src/pi/artifactVersions.ts";
import { createPiRuntimeController } from "../../src/pi/piRuntimeController.ts";
import { createWorkspaceDocument, readWorkspaceDocument, replaceWorkspaceDocument } from "../../src/pi/workspaceFiles.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "../../src/pi/workspaceLayout.ts";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const resultUrl = new URL("./project-handoff-check.json", import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), "rtb-handoff-acceptance-")));
const dataDir = join(root, "data"), layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "workspace") });
const report = { status: "failed", checkedAt: new Date().toISOString(), controlledWorkflow: true, realModel: false,
  limitations: ["Deterministic injected bridge; no model or network calls.", "No-change save/publish is skipped by this caller, not enforced by a new host feature.", "Temporary data only; no user Skill installation or configuration changes.", "Hashes and preserved bytes do not prove semantic correctness or model adherence."], checks: [], runs: [] };
let controller;
try {
  const source = await readFile(new URL("../../docs/task-skills/project-handoff.md", import.meta.url), "utf8");
  const parts = source.split(/^## (?:name|description|instructions)\s*$/m);
  assert.equal(parts.length, 4);
  const [name, description, instructions] = parts.slice(1).map(value => value.trim());
  let skills = createBotSkillsService({ dataDir });
  const skill = skills.save({ name, description, instructions }, 0).skills[0];
  assert.equal(skill.instructions, instructions);
  report.skill = { source: "docs/task-skills/project-handoff.md", sourceSha256: sha256(source), name, instructionsSha256: sha256(instructions) };
  ensureWorkspaceLayout(layout);
  const retained = ["USER_KEEP: Retain this exact user note.", "Selected: Keep one PROJECT.md; avoids duplicate state.",
    "Rejected: Add a database; no concrete requirement.", "Revisit: Only if cross-host synchronization becomes necessary."];
  const initial = ["# Project handoff", "Goal: Validate a local file handoff.", ...retained, "State: Planned.",
    "Next: Implement step 1.", "Open: Real model behavior remains unverified."].join("\n") + "\n";
  const doc = await createWorkspaceDocument(layout, "shared", "PROJECT.md", initial);
  const path = join(layout.shared, doc.path);
  assert.equal(sha256(await readFile(path)), doc.version);
  report.initialSha256 = doc.version;
  let stage = 0;
  const failures = [];
  const bridgeFactory = async ({ hostTools }) => {
    let emit = () => {};
    return { subscribe(fn) { emit = fn; return () => {}; }, async configure() {}, async abort() {}, dispose() {},
      async newSession() {}, async state() { return { models: [], tools: [] }; },
      async prompt(prompt) {
        try {
          const loaded = await skills.toolsFor(() => [skill.id]).run("read_skill", { id: skill.id });
          assert.equal(loaded.isError, false); assert.ok(loaded.text.includes(instructions));
          const attached = JSON.parse(prompt.match(/<attached_workspace_files>[\s\S]*?\n(\[[^\n]+\])\n<\/attached_workspace_files>/)[1]);
          assert.equal(attached[0].path, path);
          let before = await readWorkspaceDocument(layout, "shared", doc.path);
          assert.equal(await readFile(attached[0].path, "utf8"), before.content);
          for (const text of retained) assert.ok(before.content.includes(text));
          emit({ type: "message_start", message: { role: "assistant" } });
          if (stage === 1) {
            assert.match(before.content, /State: Step 1 complete/);
            const concurrent = await replaceWorkspaceDocument(layout, "shared", doc.path, `${before.content}USER_EDIT: Keep this concurrent edit.\n`, before.version);
            await assert.rejects(replaceWorkspaceDocument(layout, "shared", doc.path, "stale overwrite", before.version), error => error.status === 409);
            assert.equal(await readFile(path, "utf8"), concurrent.content);
            before = await readWorkspaceDocument(layout, "shared", doc.path);
            report.concurrentSha256 = before.version;
            report.checks.push("stale version rejected with 409; concurrent user bytes preserved");
          }
          const content = stage === 0 ? before.content.replace("State: Planned.", "State: Step 1 complete; controlled fixture saved.").replace("Next: Implement step 1.", "Next: Implement step 2.")
            : stage === 1 ? before.content.replace("Next: Implement step 2.", "Next: Review controlled fixture evidence.").replace("State: Step 1 complete; controlled fixture saved.", "State: Step 2 complete; controlled fixture reread.") : before.content;
          if (content === before.content) {
            report.runs.push({ stage, changed: false, skippedSaveAndPublish: true, sha256: before.version });
          } else {
            const saved = await replaceWorkspaceDocument(layout, "shared", doc.path, content, before.version);
            const actual = await readFile(path);
            assert.equal(sha256(actual), saved.version); assert.notEqual(saved.version, before.version);
            assert.equal((await readWorkspaceDocument(layout, "shared", doc.path)).content, content);
            for (const text of retained) assert.ok(actual.toString().includes(text));
            if (stage === 1) assert.match(actual.toString(), /USER_EDIT: Keep this concurrent edit/);
            const published = await hostTools.run("publish_artifact", { path, preserveVersion: true });
            assert.equal(published.isError, false, published.text);
            const receipt = JSON.parse(published.text); assert.equal(receipt.preservedVersion, true);
            report.runs.push({ stage, changed: true, beforeSha256: before.version, afterSha256: saved.version, versionId: receipt.versionId, content });
          }
          stage++;
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        } catch (error) { failures.push(error); throw error; }
      } };
  };
  const start = () => createPiRuntimeController({ cwd: layout.agents.assistant, dataDir, layout, sandboxed: false, bridgeFactory });
  const run = async (conversationId, requestId) => {
    await controller.runPrompt({ conversationId, requestId, prompt: "Continue the explicitly attached project file.", agentPreset: "assistant",
      attachments: [{ scope: "shared", path: doc.path }] }, () => {}, { title: "Controlled project handoff" });
    assert.equal(failures.length, 0, failures.map(error => error.stack).join("\n"));
  };
  controller = start();
  await run("handoff-first", "handoff-run-1");
  controller.dispose();
  skills = createBotSkillsService({ dataDir });
  assert.equal(skills.state().skills[0].instructions, instructions);
  controller = start();
  assert.ok(controller.getConversation("handoff-first"));
  await run("handoff-next", "handoff-run-2");
  const query = conversationId => ({ conversationId, scope: "shared", path: doc.path, agent: "assistant" });
  const beforeNoChange = await readWorkspaceDocument(layout, "shared", doc.path);
  await run("handoff-next", "handoff-run-3");
  assert.equal((await readWorkspaceDocument(layout, "shared", doc.path)).version, beforeNoChange.version);
  assert.equal((await controller.artifactVersions.list(query("handoff-next"))).length, 1);
  report.checks.push("Skill and first conversation reloaded; new conversation read existing file", "USER_KEEP and selected/rejected decision text retained", "no-change follow-up skipped save and produced no new delivery");
  await replaceWorkspaceDocument(layout, "shared", doc.path, `${beforeNoChange.content}SOURCE_CHANGED_AFTER_DELIVERY\n`, beforeNoChange.version);
  report.sourceChangedSha256 = sha256(await readFile(path));
  const reloadedVersions = new ArtifactVersionStore(`${dataDir}.artifact-versions`);
  for (const [index, conversationId] of ["handoff-first", "handoff-next"].entries()) {
    const records = await reloadedVersions.list(query(conversationId)); assert.equal(records.length, 1);
    const opened = await reloadedVersions.open({ conversationId, versionId: records[0].versionId });
    try {
      const bytes = await opened.file.readFile();
      assert.equal(bytes.toString(), report.runs[index].content);
      assert.equal(sha256(bytes), report.runs[index].afterSha256);
      assert.notEqual(sha256(bytes), report.sourceChangedSha256);
    } finally { await opened.file.close(); }
    delete report.runs[index].content;
  }
  report.checks.push("two preserved delivery versions retain exact bytes after source changes and store reload");
  report.simulatedConversations = ["handoff-first", "handoff-next"];
  report.status = "passed";
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  controller?.dispose();
  await rm(root, { recursive: true, force: true });
  await writeFile(resultUrl, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, result: resultUrl.pathname, error: report.error }));
}
