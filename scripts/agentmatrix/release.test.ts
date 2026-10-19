import assert from "node:assert/strict";
import { test } from "node:test";

import { EXCLUDES, manifestFor, releaseName } from "./release.mjs";

test("releaseName is commit-scoped and marks local edits", () => {
  assert.equal(releaseName("abcdef1234567890", false), "raytonebot-abcdef12.tar.gz");
  assert.equal(releaseName("abcdef1234567890", true), "raytonebot-abcdef12-dirty.tar.gz");
  assert.equal(releaseName("", false), "raytonebot-worktree.tar.gz");
});

test("manifest records the frozen versions the upload is checked against", () => {
  const manifest = manifestFor({
    commit: "abc", dirty: false, builtAt: "2026-10-19T00:00:00.000Z", sdkVersion: "0.11.0", contractVersion: "0.154.0",
  });
  assert.equal(manifest.entry, "scripts/cloud-preview.mjs");
  assert.equal(manifest.port, 5188);
  assert.equal(manifest.sdkVersion, "0.11.0");
  assert.equal(manifest.contractVersion, "0.154.0");
});

test("host state and credentials never enter the archive", () => {
  for (const entry of [".agentsphere", ".agentmatrix", "node_modules", "backups", ".git"]) {
    assert.ok(EXCLUDES.includes(entry), `${entry} must be excluded`);
  }
});
