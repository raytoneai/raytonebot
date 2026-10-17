import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactTools, type PublishedArtifact } from "./artifactTool.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import { workArtifacts } from "../runtime/workArtifacts.ts";
import { openWorkspaceFile } from "./workspaceFiles.ts";

test("explicit shell artifacts use real files, latest-path deduplication and existing file boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-publish-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root }); ensureWorkspaceLayout(layout);
  const published: PublishedArtifact[] = [];
  const adapter = createPiEventAdapter({ runId: "published" }); adapter.startUserMessage("Create files");
  const tools = artifactTools(layout, "builder", [], (file) => { published.push(file); adapter.apply({ type: "artifact_published", ...file }); });
  const run = (path: string) => tools.run("publish_artifact", { path });
  try {
    for (const [name, bytes] of [["report.html", "<h1>real HTML</h1>"], ["report.pdf", "%PDF-1.7\nreal PDF"], ["pixel.png", "real image bytes"]]) {
      writeFileSync(join(layout.agents.builder, name), bytes);
      assert.equal((await run(name)).isError, false);
    }
    writeFileSync(join(layout.agents.builder, "report.html"), "<h1>new version</h1>");
    assert.equal((await run("report.html")).isError, false);
    assert.equal(published.length, 4);
    const view = createAgentUXViewModel(adapter.events);
    const files = workArtifacts(view.timeline);
    assert.equal(files.length, 3);
    assert.equal(files.find((f) => f.title?.endsWith("report.html"))?.id, published[3].artifactId);
    assert.ok(files.every((f) => !f.content && !f.data), "history contains references, never invented file bytes");
    renameSync(join(layout.agents.builder, "report.html"), join(layout.agents.builder, "renamed.html"));
    assert.equal((await run("report.html")).isError, true);
    await assert.rejects(openWorkspaceFile(layout, "builder", "report.html"));
    assert.equal((await run("renamed.html")).isError, false);
    symlinkSync(join(layout.agents.builder, "renamed.html"), join(layout.agents.builder, "link.html"));
    for (const path of ["missing.pdf", "link.html", ".env", "../builder/renamed.html", join(layout.agents.planner, "SOUL.md"), "/etc/passwd"]) assert.equal((await run(path)).isError, true, path);
    writeFileSync(join(layout.shared!, "shared.html"), "shared");
    assert.equal((await run(join(layout.shared!, "shared.html"))).isError, false);
    const stopped = new AbortController(); stopped.abort();
    assert.equal((await tools.run("publish_artifact", { path: "renamed.html" }, stopped.signal)).isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
