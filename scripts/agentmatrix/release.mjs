/**
 * Builds the fixed RaytoneBot release archive the AgentMatrix deployment uploads.
 *
 * The archive is the whole application, not just `dist/`: the Node host under
 * `src/pi/**` and the Vite preview server are production code, and the vendor
 * builds are frozen inputs. `node_modules` is rebuilt inside the Environment by
 * `npm ci` so the package stays far below the 20 MiB attachment cap.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { AM } from "./config.mjs";

const exec = promisify(execFile);

/** Paths that are host state, credentials, or build input, never release content. */
export const EXCLUDES = [
  ".git", "node_modules", ".agentsphere", "backups", "output", "artifacts", "tmp",
  ".agentmatrix", ".claude", ".DS_Store",
];

const run = async (command, args, cwd, env = {}) => {
  const { stdout } = await exec(command, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
};

export function releaseName(commit, dirty) {
  return `raytonebot-${(commit || "worktree").slice(0, 8)}${dirty ? "-dirty" : ""}.tar.gz`;
}

export function manifestFor({ commit, dirty, builtAt, sdkVersion, contractVersion }) {
  return {
    app: "raytonebot",
    package: "agentmatrix",
    commit,
    dirty,
    builtAt,
    sdkVersion,
    contractVersion,
    entry: "scripts/cloud-preview.mjs",
    port: AM.port,
  };
}

/**
 * Builds `dist/`, packs the release, and returns its digest. Reusing an existing
 * archive is allowed only for the same commit with a clean tree.
 *
 * @returns {Promise<{file: string, bytes: number, sha256: string, commit: string,
 *   dirty: boolean, builtAt: string}>}
 */
export async function buildRelease({ repoRoot, outDir, skipBuild = false, log = () => {} }) {
  const commit = await run("git", ["rev-parse", "HEAD"], repoRoot);
  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], repoRoot);
  const dirty = status.length > 0;
  if (!skipBuild) {
    log("build: running npm run build");
    await exec("npm", ["run", "build"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  }
  if (!existsSync(join(repoRoot, "dist", "index.html"))) {
    throw new Error("dist/index.html is missing; run `npm run build` or drop --skip-build");
  }

  const sdkVersion = readSdkVersion(repoRoot);
  const manifest = manifestFor({
    commit, dirty, builtAt: new Date().toISOString(), sdkVersion, contractVersion: readContractVersion(repoRoot),
  });

  const destination = resolve(outDir);
  mkdirSync(destination, { recursive: true });
  const file = join(destination, releaseName(commit, dirty));
  rmSync(file, { force: true });
  const manifestDir = join(destination, "manifest");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "AM-RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // bsdtar on macOS would otherwise add LIBARCHIVE.xattr headers that GNU tar on the
  // sandbox reports for every entry, flooding the agent's output.
  const metadataFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
  const args = ["-czf", file, ...metadataFlags,
    ...EXCLUDES.map((entry) => `--exclude=${entry}`), "--exclude=._*",
    "-C", repoRoot, ".", "-C", manifestDir, "AM-RELEASE.json"];
  await run("tar", args, repoRoot, { COPYFILE_DISABLE: "1" });

  const bytes = statSync(file).size;
  if (bytes > AM.maxAttachmentBytes) {
    throw new Error(`release is ${bytes} bytes, above the ${AM.maxAttachmentBytes} byte attachment cap`);
  }
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, bytes, sha256, commit, dirty, builtAt: manifest.builtAt };
}

/**
 * Builds the release from `HEAD` in a throwaway worktree, so uncommitted work in
 * the developer's tree can never leak into a deployed archive.
 */
export async function buildReleaseFromHead({ repoRoot, outDir, log = () => {} }) {
  const checkout = mkdtempSync(join(tmpdir(), "raytonebot-release-"));
  await run("git", ["worktree", "add", "--detach", checkout, "HEAD"], repoRoot);
  try {
    symlinkSync(join(repoRoot, "node_modules"), join(checkout, "node_modules"));
    log(`release: building HEAD in ${checkout}`);
    return await buildRelease({ repoRoot: checkout, outDir, skipBuild: false, log });
  } finally {
    await run("git", ["worktree", "remove", "--force", checkout], repoRoot).catch(() => {});
    rmSync(checkout, { recursive: true, force: true });
  }
}

/** Reads the version from the installed SDK rather than a hard-coded literal. */
export function readSdkVersion(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "node_modules", "@agentmatrix.pro", "sdk", "package.json"), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
}

export function readContractVersion(repoRoot) {
  try {
    const url = import.meta.resolve("@agentmatrix.pro/sdk");
    const source = readFileSync(new URL(url), "utf8");
    return /CONTRACT_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}
