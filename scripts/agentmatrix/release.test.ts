import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { buildRelease, buildReleaseFromHead, EXCLUDES, manifestFor, releaseName } from "./release.mjs";
import { verifyManifest } from "../observer-manifest.mjs";

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

function writeFixtureFile(root, relativePath, contents) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createReleaseFixture({ failingBuild = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "raytonebot-release-fixture-"));
  try {
    writeFixtureFile(root, "package.json", `${JSON.stringify({
      name: "raytonebot-release-fixture",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { build: "node build.mjs" },
      dependencies: {
        probe: "file:vendor/probe",
        "@agentmatrix.pro/sdk": "file:vendor/sdk",
      },
    }, null, 2)}\n`);
    writeFixtureFile(root, "vendor/probe/package.json", `${JSON.stringify({
      name: "probe", version: "1.0.0", type: "module", exports: "./index.js",
    }, null, 2)}\n`);
    writeFixtureFile(root, "vendor/probe/index.js", 'export const value = "CLEAN_HEAD";\n');
    writeFixtureFile(root, "docs/observer-guide.md", "Versioned repository evidence.\n");
    writeFixtureFile(root, "vendor/sdk/package.json", `${JSON.stringify({
      name: "@agentmatrix.pro/sdk", version: "0.0.1", type: "module",
      exports: { ".": { import: "./dist/index.js" } }, main: "./dist/index.js",
    }, null, 2)}\n`);
    writeFixtureFile(root, "vendor/sdk/dist/index.js", 'export const CONTRACT_VERSION = "head-contract";\n');
    writeFixtureFile(root, "build.mjs", failingBuild
      ? "process.exit(23);\n"
      : [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { value } from "probe";',
        'mkdirSync("dist", { recursive: true });',
        'writeFileSync("dist/index.html", value);',
        "",
      ].join("\n"));

    execFileSync("npm", [
      "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error",
    ], { cwd: root, stdio: "ignore" });
    git(root, ["init", "--quiet", "-b", "main"]);
    git(root, ["config", "user.name", "release fixture"]);
    git(root, ["config", "user.email", "release-fixture@example.invalid"]);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "HEAD"]);

    mkdirSync(join(root, "node_modules", "@agentmatrix.pro"), { recursive: true });
    symlinkSync("../vendor/probe", join(root, "node_modules", "probe"), "dir");
    symlinkSync("../../vendor/sdk", join(root, "node_modules", "@agentmatrix.pro", "sdk"), "dir");
    writeFixtureFile(root, "vendor/probe/index.js", 'export const value = "DIRTY_WORKTREE";\n');
    writeFixtureFile(root, "vendor/sdk/package.json", `${JSON.stringify({
      name: "@agentmatrix.pro/sdk", version: "0.0.2", type: "module",
      exports: { ".": { import: "./dist/index.js" } }, main: "./dist/index.js",
    }, null, 2)}\n`);
    writeFixtureFile(root, "vendor/sdk/dist/index.js", 'export const CONTRACT_VERSION = "dirty-contract";\n');
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function archiveEntry(file, entry) {
  return execFileSync("tar", ["-xOzf", file, entry], { encoding: "utf8" });
}

test("worktree release excludes untracked files and nested private files, including in dist", async () => {
  const root = createReleaseFixture();
  try {
    writeFixtureFile(root, "dist/index.html", "built");
    writeFixtureFile(root, "dist/.env.local", "secret");
    writeFixtureFile(root, "scripts/private.txt", "secret");
    writeFixtureFile(root, "vendor/probe/.env.production", "secret");
    writeFixtureFile(root, "vendor/probe/id_ed25519", "secret");
    git(root, ["add", "-f", "vendor/probe/.env.production", "vendor/probe/id_ed25519"]);
    const release = await buildRelease({ repoRoot: root, outDir: join(root, "out"), skipBuild: true });
    const entries = execFileSync("tar", ["-tzf", release.file], { encoding: "utf8" });
    assert.match(entries, /vendor\/probe\/index\.js/);
    assert.match(entries, /dist\/index\.html/);
    assert.doesNotMatch(entries, /\.env|id_ed25519|private\.txt/);
    const snapshot = join(root, "extracted"); mkdirSync(snapshot);
    execFileSync("tar", ["-xzf", release.file, "-C", snapshot]);
    const manifest = JSON.parse(archiveEntry(release.file, "OBSERVER-BUILD.json"));
    assert.ok(manifest.files.some(file => file.path === "docs/observer-guide.md"));
    assert.ok(manifest.files.some(file => file.path === "dist/index.html"));
    assert.ok(!manifest.files.some(file => file.path === "OBSERVER-BUILD.json"));
    verifyManifest(snapshot, manifest);
    writeFileSync(join(snapshot, "dist/index.html"), "changed after packaging");
    assert.throws(() => verifyManifest(snapshot, manifest), /observer_source_changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clean HEAD releases reinstall checkout dependencies and metadata from HEAD", async () => {
  const root = createReleaseFixture();
  try {
    const release = await buildReleaseFromHead({ repoRoot: root, outDir: join(root, "out") });
    const manifest = JSON.parse(archiveEntry(release.file, "AM-RELEASE.json"));
    assert.equal(release.dirty, false);
    assert.equal(archiveEntry(release.file, "./dist/index.html"), "CLEAN_HEAD");
    assert.equal(archiveEntry(release.file, "./vendor/probe/index.js"), 'export const value = "CLEAN_HEAD";\n');
    assert.equal(manifest.sdkVersion, "0.0.1");
    assert.equal(manifest.contractVersion, "head-contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean HEAD releases remove the temporary worktree when the build fails", async () => {
  const root = createReleaseFixture({ failingBuild: true });
  try {
    const before = git(root, ["worktree", "list", "--porcelain"]);
    await assert.rejects(() => buildReleaseFromHead({ repoRoot: root, outDir: join(root, "out") }));
    assert.equal(git(root, ["worktree", "list", "--porcelain"]), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
