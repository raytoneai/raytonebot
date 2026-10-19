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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { AM } from "./config.mjs";

const exec = promisify(execFile);

/** Paths that are host state, credentials, or build input, never release content. */
export const EXCLUDES = [
  ".git", "node_modules", ".agentsphere", "backups", "output", "artifacts", "tmp",
  ".agentmatrix", ".claude", ".DS_Store",
];

const run = async (command, args, cwd) => {
  const { stdout } = await exec(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
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

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, releaseName(commit, dirty));
  rmSync(file, { force: true });
  const manifestDir = join(outDir, "manifest");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "AM-RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const args = ["-czf", file, ...EXCLUDES.map((entry) => `--exclude=${entry}`),
    "-C", repoRoot, ".", "-C", manifestDir, "AM-RELEASE.json"];
  await run("tar", args, repoRoot);

  const bytes = statSync(file).size;
  if (bytes > AM.maxAttachmentBytes) {
    throw new Error(`release is ${bytes} bytes, above the ${AM.maxAttachmentBytes} byte attachment cap`);
  }
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, bytes, sha256, commit, dirty, builtAt: manifest.builtAt };
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
