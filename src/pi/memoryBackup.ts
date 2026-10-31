import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { isMemoryFile, type MemoryFile } from "./memories.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const FILES = ["memories.json", "memories.md"] as const;
type Digest = { sha256: string; bytes: number };
type Manifest = { format: "raytonebot-memory-backup"; formatVersion: 1; status: "completed"; createdAt: string;
  version: number; enabled: boolean; count: number; files: Record<typeof FILES[number], Digest> };
export class MemoryBackupError extends Error {}
function fail(message: string): never { throw new MemoryBackupError(message); }
const digest = (bytes: Buffer): Digest => ({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

function explicitPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) fail("Explicit paths are required.");
  return resolve(value);
}

function inputDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Input must be an existing directory, not a link.");
}

/** One bounded descriptor read; growth, in-place changes, links and special files fail closed. */
function readStable(path: string, limit = MAX_BYTES): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) fail("Input must be a bounded regular file with one link.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (offset !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) fail("Input changed while being read; retry with a stable file.");
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return fail("Backup input contains invalid UTF-8 or JSON."); }
}

function parseMemories(bytes: Buffer): MemoryFile {
  const value = parseJson(bytes);
  if (!isMemoryFile(value)) fail("Memory file schema is invalid.");
  return value;
}

function parseManifest(bytes: Buffer): Manifest {
  const value = parseJson(bytes);
  if (!record(value) || !exactKeys(value, ["format", "formatVersion", "status", "createdAt", "version", "enabled", "count", "files"])
    || value.format !== "raytonebot-memory-backup" || value.formatVersion !== 1 || value.status !== "completed"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.enabled !== "boolean"
    || typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0
    || !record(value.files) || !exactKeys(value.files, FILES)) fail("Backup manifest is invalid or incomplete.");
  for (const name of FILES) {
    const item = value.files[name];
    if (!record(item) || !exactKeys(item, ["sha256", "bytes"]) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_BYTES) fail("Backup manifest file metadata is invalid.");
  }
  return value as Manifest;
}

function markdown(data: MemoryFile): Buffer {
  const escape = (value: string) => value.replace(/[\\`*_{}[\]()#+.!|\-]/g, "\\$&").replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const lines = ["# RaytoneBot memory backup", "", `Version: ${data.version}; enabled: ${data.enabled}; count: ${data.memories.length}.`,
    "Readable copy only; restore uses memories.json. Source dates are submitted records, not host verification.", ""];
  for (const memory of data.memories) {
    const scope = !memory.scope ? "global (legacy)" : memory.scope.kind === "global" ? "global" : `${memory.scope.kind}:${memory.scope.id}`;
    lines.push(`## ${escape(memory.id)}`, "", escape(memory.text), "", `- Scope: ${escape(scope)}`, `- Created: ${memory.createdAt}; updated: ${memory.updatedAt}`);
    if (memory.source) lines.push(`- Source: ${escape(memory.source.conversationId)}; agent: ${escape(memory.source.agent)}${memory.source.botId ? `; Bot: ${escape(memory.source.botId)}` : ""}`);
    if (memory.evidence) lines.push(`- Evidence: ${escape(memory.evidence.url)}; checkedAt: ${memory.evidence.checkedAt ?? "not supplied"}`);
    lines.push("");
  }
  return Buffer.from(lines.join("\n"));
}

function stillOwned(path: string, original: BigIntStats): boolean {
  try { const current = lstatSync(path, { bigint: true }); return current.dev === original.dev && current.ino === original.ino; }
  catch { return false; }
}

/** mkdir and wx establish ownership; failed work never removes concurrent unknown/replaced files. */
function writeNewDirectory<T>(directory: string, work: (write: (name: string, bytes: Buffer) => void) => T): T {
  mkdirSync(directory, { mode: 0o700 });
  const owner = lstatSync(directory, { bigint: true });
  const created: { path: string; stat: BigIntStats }[] = [];
  try {
    chmodSync(directory, 0o700);
    const result = work((name, bytes) => {
      const path = join(directory, name), fd = openSync(path, "wx", 0o600);
      created.push({ path, stat: fstatSync(fd, { bigint: true }) });
      try { writeFileSync(fd, bytes); fchmodSync(fd, 0o600); fsyncSync(fd); }
      finally { closeSync(fd); }
      if (!readStable(path).equals(bytes)) fail("Written backup data did not pass readback verification.");
    });
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return result;
  } catch (error) {
    for (const item of created.reverse()) {
      try { if (stillOwned(item.path, item.stat)) unlinkSync(item.path); } catch { /* Leave anything that cannot be safely removed. */ }
    }
    try { if (stillOwned(directory, owner)) rmdirSync(directory); } catch { /* Unknown concurrent files keep their directory. */ }
    throw error;
  }
}

/** The manifest detects corruption; it is not a signature or proof of source authenticity. */
export function exportMemories(options: { dataDir: string; outputDir: string }) {
  const source = explicitPath(options.dataDir), directory = explicitPath(options.outputDir);
  inputDirectory(source);
  const bytes = readStable(join(source, "memories.json")), data = parseMemories(bytes), readable = markdown(data);
  if (readable.length > MAX_BYTES) fail("Readable backup exceeds the size limit.");
  const manifest: Manifest = { format: "raytonebot-memory-backup", formatVersion: 1, status: "completed", createdAt: new Date().toISOString(),
    version: data.version, enabled: data.enabled, count: data.memories.length, files: { "memories.json": digest(bytes), "memories.md": digest(readable) } };
  return writeNewDirectory(directory, write => {
    write("memories.json", bytes); write("memories.md", readable); write("manifest.json", jsonBytes(manifest));
    return { operation: "export" as const, status: "completed" as const, directory, count: manifest.count, version: data.version, enabled: data.enabled, files: manifest.files };
  });
}

/** Restore only while the host is stopped, into a directory that does not yet exist. */
export function restoreMemories(options: { backupDir: string; dataDir: string }) {
  const backup = explicitPath(options.backupDir), directory = explicitPath(options.dataDir);
  inputDirectory(backup);
  const manifest = parseManifest(readStable(join(backup, "manifest.json"), 16 * 1024));
  const bytes = readStable(join(backup, "memories.json")), readable = readStable(join(backup, "memories.md"));
  for (const [name, content] of [["memories.json", bytes], ["memories.md", readable]] as const) {
    const actual = digest(content), expected = manifest.files[name];
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail("Backup file checksum or byte length does not match its manifest.");
  }
  const data = parseMemories(bytes);
  if (data.version !== manifest.version || data.enabled !== manifest.enabled || data.memories.length !== manifest.count) fail("Backup manifest does not match the memory data.");
  const result = { operation: "restore" as const, status: "completed" as const, directory, count: data.memories.length, version: data.version, enabled: data.enabled,
    ...digest(bytes), restoredAt: new Date().toISOString() };
  return writeNewDirectory(directory, write => { write("memories.json", bytes); write("memory-restore.json", jsonBytes(result)); return result; });
}
