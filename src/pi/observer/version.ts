import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setImmediate as yieldIO } from "node:timers/promises";
import { allowedManifestPath, canonicalHash, hashBytes, readVerifiedFile, trackedManifest, validateManifest, verifyManifest } from "../../../scripts/observer-manifest.mjs";
import { ObserverError, type BuildStamp, type RepoSnapshot } from "./types.ts";
export { canonicalHash, readVerifiedFile };
function manifestBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error();
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd), pathAfter = lstatSync(path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs) throw new Error();
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
function selectedManifest(root: string, explicit?: string) { return explicit ?? (lstatSync(join(root, "OBSERVER-BUILD.json"), { throwIfNoEntry: false }) ? join(root, "OBSERVER-BUILD.json") : undefined); }
function trackedPaths(root: string) { return [...new Set(execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(path => path && allowedManifestPath(path)))].sort(); }
function snapshot(root: string, buildStamp: BuildStamp, manifestPath?: string, manifestFileHash?: string): RepoSnapshot {
  const files = buildStamp.files.filter(file => !/^(?:dist|node_modules)\//.test(file.path));
  return { root, buildStamp, files, readScopeHash: canonicalHash(files), ...(manifestPath ? { manifestPath, manifestFileHash } : {}) };
}
function verifyIdentity(repo: RepoSnapshot) {
  if (canonicalHash(repo.buildStamp.files) !== repo.buildStamp.manifestHash || canonicalHash(repo.files) !== repo.readScopeHash) throw new Error();
  if (repo.manifestPath) { if (hashBytes(manifestBytes(repo.manifestPath)) !== repo.manifestFileHash) throw new Error(); }
  else if (JSON.stringify(trackedPaths(repo.root)) !== JSON.stringify(repo.buildStamp.files.map(file => file.path))) throw new Error();
}
export function createRepoSnapshot(options: { root: string; manifestPath?: string; buildId?: string }): RepoSnapshot {
  try {
    const root = realpathSync(options.root), manifestPath = selectedManifest(root, options.manifestPath), raw = manifestPath ? manifestBytes(manifestPath) : undefined;
    const build = raw ? verifyManifest(root, JSON.parse(raw.toString("utf8"))) : trackedManifest(root, { buildId: options.buildId });
    return snapshot(root, build, manifestPath, raw ? hashBytes(raw) : undefined);
  } catch { throw new ObserverError("observer_manifest_invalid", 409); }
}
export function verifyRepoSnapshot(repo: RepoSnapshot): void {
  try { verifyManifest(repo.root, repo.buildStamp); verifyIdentity(repo); }
  catch { throw new ObserverError("observer_source_changed", 409); }
}
/** Yield between bounded file reads so cancellation and ordinary chat remain responsive. */
export async function verifyRepoSnapshotAsync(repo: RepoSnapshot, options: { signal?: AbortSignal; check?(): void } = {}): Promise<void> {
  try {
    validateManifest(repo.buildStamp);
    for (const file of repo.buildStamp.files) { await yieldIO(); if (options.signal?.aborted) throw new ObserverError("observer_cancelled", 409); options.check?.(); readVerifiedFile(repo.root, file.path, file.hash); }
    verifyIdentity(repo); options.check?.();
  } catch (error) { if (error instanceof ObserverError) throw error; throw new ObserverError("observer_source_changed", 409); }
}
export async function createRepoSnapshotAsync(options: { root: string; manifestPath?: string; buildId?: string; signal?: AbortSignal; check?(): void }): Promise<RepoSnapshot> {
  const check = async () => { await yieldIO(); if (options.signal?.aborted) throw new ObserverError("observer_cancelled", 409); options.check?.(); };
  try {
    await check(); const root = realpathSync(options.root), manifestPath = selectedManifest(root, options.manifestPath);
    let build: BuildStamp, manifestFileHash: string | undefined;
    if (manifestPath) {
      const raw = manifestBytes(manifestPath); manifestFileHash = hashBytes(raw); build = validateManifest(JSON.parse(raw.toString("utf8")));
      for (const file of build.files) { await check(); if (readVerifiedFile(root, file.path, file.hash).bytes.length !== file.bytes) throw new Error(); }
      if (hashBytes(manifestBytes(manifestPath)) !== manifestFileHash) throw new Error();
    } else {
      const files: BuildStamp["files"] = [];
      for (const path of trackedPaths(root)) { await check(); const value = readVerifiedFile(root, path); files.push({ path, hash: value.hash, bytes: value.bytes.length }); }
      build = { schemaVersion: 1, gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim()), buildId: options.buildId ?? "local", files, manifestHash: canonicalHash(files) };
    }
    await check(); return snapshot(root, build, manifestPath, manifestFileHash);
  } catch (error) { if (error instanceof ObserverError) throw error; throw new ObserverError("observer_manifest_invalid", 409); }
}
