import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const hashBytes = value => createHash('sha256').update(value).digest('hex');
export const canonicalHash = value => hashBytes(JSON.stringify(value));
export function allowedManifestPath(path) {
  return typeof path === 'string' && path !== 'OBSERVER-BUILD.json' && path.length <= 1000 && !/[\\\u0000-\u001f\u007f]/.test(path) && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
    && !/(?:^|\/)(?:\.git|node_modules|\.env(?:\.(?!example$|sample$)[^/]*)?|\.ssh|\.aws|\.codex|\.claude|\.pi|backups?|logs?|runtime-data|credentials?|secrets?)(?:\/|$)/i.test(path)
    && !/(?:\.pem|\.key|\.enc|\.p12|\.pfx|\.sqlite(?:3)?|\.db)$/i.test(path)
    && !/(?:^|\/)(?:auth|credentials|secrets|providers)\.json$/i.test(path)
    && !/(?:^|\/)[^/]*\.(?:vault|provider-secrets|control-plane)(?:\/|$)/i.test(path);
}
export function readVerifiedFile(root, path, expectedHash, maxBytes = 16 * 1024 * 1024) {
  if (!allowedManifestPath(path)) throw new Error('observer_path_denied');
  const base = realpathSync(root), target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || realpathSync(target) !== target || !lstatSync(target).isFile()) throw new Error('observer_path_denied');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('observer_read_limit');
    const buffer = Buffer.alloc(Math.min(maxBytes, before.size) + 1);
    let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd), pathAfter = statSync(target);
    if (bytes.length > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || after.size !== pathAfter.size || after.mtimeMs !== pathAfter.mtimeMs || after.ctimeMs !== pathAfter.ctimeMs || realpathSync(target) !== target) throw new Error('observer_source_changed');
    const hash = hashBytes(bytes);
    if (expectedHash && hash !== expectedHash) throw new Error('observer_source_changed');
    return { bytes, hash };
  } finally { closeSync(fd); }
}
export function createManifest(root, paths, { gitRevision = null, dirty = null, buildId = 'local' } = {}) {
  if (!Array.isArray(paths) || paths.some(path => !allowedManifestPath(path))) throw new Error('observer_path_denied');
  const files = [...new Set(paths)].sort().map(path => {
    const { bytes, hash } = readVerifiedFile(root, path);
    return { path, hash, bytes: bytes.length };
  });
  return { schemaVersion: 1, gitRevision, dirty, buildId, files, manifestHash: canonicalHash(files) };
}
export function trackedManifest(root, options = {}) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  const gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim());
  // The manifest file must not include its own bytes; deployment passes its package file set explicitly.
  return createManifest(root, paths.filter(path => path !== options.manifestPath && allowedManifestPath(path)), { ...options, gitRevision, dirty });
}
export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || Object.keys(manifest).some(key => !['schemaVersion','gitRevision','dirty','manifestHash','buildId','files'].includes(key)) || !(manifest.gitRevision === null || typeof manifest.gitRevision === 'string' && /^[a-f0-9]{7,64}$/.test(manifest.gitRevision)) || !(manifest.dirty === null || typeof manifest.dirty === 'boolean') || typeof manifest.buildId !== 'string' || manifest.buildId.length > 200 || !Array.isArray(manifest.files) || manifest.files.length > 100000 || typeof manifest.manifestHash !== 'string'
    || !manifest.files.every(file => file && Object.keys(file).every(key => ['path','hash','bytes'].includes(key)) && allowedManifestPath(file.path) && /^[a-f0-9]{64}$/.test(file.hash) && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
    || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
    || canonicalHash(manifest.files) !== manifest.manifestHash || manifest.files.some((file, index) => index && manifest.files[index - 1].path >= file.path)) throw new Error('observer_manifest_invalid');
  return manifest;
}
export function verifyManifest(root, manifest) {
  validateManifest(manifest);
  for (const file of manifest.files) if (readVerifiedFile(root, file.path, file.hash).bytes.length !== file.bytes) throw new Error('observer_source_changed');
  return manifest;
}
