import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  lstat,
  type FileHandle,
} from "node:fs/promises";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ArtifactVersion } from "../runtime/artifactVersions.ts";
import { isAgentPresetId, type AgentPresetId } from "./harnessCatalog.ts";

export const ARTIFACT_VERSION_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_VERSION_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export class ArtifactVersionError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export type ArtifactVersionSaveInput = {
  /** Public conversation identity: a group id for group projections, otherwise the source id. */
  conversationId: string;
  /** Hidden child/source conversation that actually ran the tool. */
  sourceConversationId: string;
  /** The id shown by the conversation UI (member~id for group projections). */
  artifactId: string;
  /** The unprojected event id emitted by the source adapter. */
  sourceArtifactId: string;
  /** Raw artifact id persisted in the public conversation event (member~native for groups). */
  eventArtifactId: string;
  runId: string;
  sourceRunId: string;
  scope: "shared" | AgentPresetId;
  path: string;
  agent: AgentPresetId;
  name: string;
  title: string;
  mimeType: string;
  bytes: Buffer;
  versionId: string;
};

export type StoredArtifactVersion = Omit<ArtifactVersionSaveInput, "bytes"> & {
  createdAt: number;
  size: number;
  sha256: string;
};

export type ArtifactVersionIdentity = {
  conversationId: string;
  artifactId?: string;
  versionId?: string;
  scope?: "shared" | AgentPresetId;
  path?: string;
  agent?: AgentPresetId;
};

export type ArtifactVersionFile = {
  file: FileHandle;
  size: number;
  name: string;
  mimeType: string;
};

type DiskRecord = StoredArtifactVersion;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionArtifactPattern = /^published_version_([0-9a-f-]{36})$/i;
const idPattern = /^[a-zA-Z0-9._:~+-]{1,2048}$/;
const artifactIdentityPattern = /^(?:[^\x00-\x1f\x7f]){1,2048}$/;
const filePathPattern = /^[^\\\x00-\x1f\x7f/](?:[^\\\x00-\x1f\x7f]*[^\\\x00-\x1f\x7f/])?$/;
const safeName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240
  && !/[\\\x00-\x1f\x7f/]/.test(value) && !value.startsWith(".");

function validVersionId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && part !== "..")
    && filePathPattern.test(value.split("/").at(-1) ?? "");
}

function validRecord(value: unknown): value is DiskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DiskRecord>;
  const sourceMatch = versionArtifactPattern.exec(record.sourceArtifactId ?? "");
  if (!validVersionId(record.versionId) || !sourceMatch || !validVersionId(sourceMatch[1]) || sourceMatch[1].toLowerCase() !== record.versionId.toLowerCase()) return false;
  if (!idPattern.test(record.conversationId ?? "") || !idPattern.test(record.sourceConversationId ?? "") || !idPattern.test(record.runId ?? "") || !idPattern.test(record.sourceRunId ?? "")) return false;
  if (!validPath(record.path) || !safeName(record.name) || record.name !== basename(record.path)) return false;
  if (!artifactIdentityPattern.test(record.artifactId ?? "") || !idPattern.test(record.eventArtifactId ?? "")) return false;
  if (record.scope !== "shared" && !isAgentPresetId(record.scope)) return false;
  if (!isAgentPresetId(record.agent)) return false;
  if (typeof record.title !== "string" || record.title.length < 1 || record.title.length > 4096 || /[\x00-\x1f\x7f]/.test(record.title)) return false;
  if (typeof record.mimeType !== "string" || record.mimeType.length < 1 || record.mimeType.length > 200 || /[\x00-\x1f\x7f]/.test(record.mimeType)) return false;
  if (!Number.isInteger(record.createdAt) || !Number.isFinite(record.createdAt) || (record.createdAt ?? 0) < 0) return false;
  if (!Number.isInteger(record.size) || !Number.isFinite(record.size) || (record.size ?? 0) < 0 || (record.size ?? 0) > ARTIFACT_VERSION_MAX_BYTES) return false;
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
  return true;
}

function publicVersion(record: StoredArtifactVersion): ArtifactVersion {
  return { versionId: record.versionId, artifactId: record.artifactId, createdAt: record.createdAt, size: record.size, sha256: record.sha256 };
}

function sameIdentity(record: StoredArtifactVersion, query: ArtifactVersionIdentity): boolean {
  return record.conversationId === query.conversationId
    && (query.artifactId === undefined || record.artifactId === query.artifactId)
    && (query.versionId === undefined || record.versionId === query.versionId)
    && (query.scope === undefined || record.scope === query.scope)
    && (query.path === undefined || record.path === query.path)
    && (query.agent === undefined || record.agent === query.agent);
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** Host-only byte/metadata store for explicit artifact deliveries. */
export class ArtifactVersionStore {
  readonly root: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactVersionError("Artifact version storage is unavailable.");
    await chmod(this.root, 0o700);
  }

  private ensureRootSync(): boolean {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const stat = lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      chmodSync(this.root, 0o700);
      return true;
    } catch { return false; }
  }

  private async records(): Promise<StoredArtifactVersion[]> {
    await this.ensureRoot();
    const names = await readdir(this.root);
    const records: StoredArtifactVersion[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const versionId = name.slice(0, -5);
      if (!validVersionId(versionId)) continue;
      const metadataPath = join(this.root, name), bytesPath = join(this.root, `${versionId}.bin`);
      const metadataStat = await lstat(metadataPath).catch(() => undefined);
      if (!metadataStat || !metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1 || metadataStat.size > 256 * 1024) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(metadataPath, "utf8")); } catch { continue; }
      if (!validRecord(parsed)) continue;
      const record = parsed as DiskRecord;
      if (record.versionId !== versionId) continue;
      const bytesStat = await lstat(bytesPath).catch(() => undefined);
      if (!bytesStat || !bytesStat.isFile() || bytesStat.isSymbolicLink() || bytesStat.nlink !== 1 || bytesStat.size !== record.size) continue;
      records.push(record);
    }
    return records.sort((a, b) => a.createdAt - b.createdAt || a.versionId.localeCompare(b.versionId));
  }

  private async byteUsage(): Promise<number> {
    await this.ensureRoot();
    let total = 0;
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".bin")) continue;
      const stat = await lstat(join(this.root, name)).catch(() => undefined);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) total += stat.size;
    }
    return total;
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }

  async save(input: ArtifactVersionSaveInput): Promise<{ record: StoredArtifactVersion; version: ArtifactVersion; rollback: () => Promise<void> }> {
    return this.serialized(async () => {
      const sourceMatch = typeof input.sourceArtifactId === "string" ? versionArtifactPattern.exec(input.sourceArtifactId) : undefined;
      if (!validVersionId(input.versionId) || !sourceMatch || !validVersionId(sourceMatch[1]) || sourceMatch[1].toLowerCase() !== input.versionId.toLowerCase()
        || typeof input.artifactId !== "string" || input.artifactId.length > 2048 || !Buffer.isBuffer(input.bytes)) {
        throw new ArtifactVersionError("Invalid artifact version identity.", 400);
      }
      if (input.bytes.length > ARTIFACT_VERSION_MAX_BYTES) throw new ArtifactVersionError("A preserved artifact must be 20 MiB or smaller.", 413);
      await this.ensureRoot();
      const total = await this.byteUsage();
      if (total + input.bytes.length > ARTIFACT_VERSION_MAX_TOTAL_BYTES) {
        throw new ArtifactVersionError("Artifact version storage is full (500 MiB). Delete old conversations before preserving another delivery.", 507);
      }
      const createdAt = Date.now();
      const record: StoredArtifactVersion = {
        conversationId: input.conversationId, sourceConversationId: input.sourceConversationId, artifactId: input.artifactId,
        sourceArtifactId: input.sourceArtifactId, eventArtifactId: input.eventArtifactId, runId: input.runId, sourceRunId: input.sourceRunId, scope: input.scope, path: input.path, agent: input.agent,
        name: input.name, title: input.title, mimeType: input.mimeType, versionId: input.versionId,
        createdAt,
        size: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
      if (!validRecord(record)) throw new ArtifactVersionError("Invalid artifact version metadata.", 400);
      const bytesPath = join(this.root, `${record.versionId}.bin`), metadataPath = join(this.root, `${record.versionId}.json`);
      if (await lstat(bytesPath).catch(() => undefined) || await lstat(metadataPath).catch(() => undefined)) {
        throw new ArtifactVersionError("That artifact version already exists.", 409);
      }
      const metadata = JSON.stringify(record);
      try {
        await writePrivateFile(bytesPath, input.bytes);
        await writePrivateFile(metadataPath, Buffer.from(metadata));
      } catch (error) {
        await rm(bytesPath, { force: true }).catch(() => {});
        await rm(metadataPath, { force: true }).catch(() => {});
        throw new ArtifactVersionError(error instanceof Error ? error.message : "Artifact version could not be saved.");
      }
      let rolledBack = false;
      return { record, version: publicVersion(record), rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        await this.removeVersion(record.versionId);
      } };
    });
  }

  async list(query: ArtifactVersionIdentity & { path: string; agent: AgentPresetId; scope: "shared" | AgentPresetId }): Promise<StoredArtifactVersion[]> {
    const records = await this.records();
    return records.filter(record => sameIdentity(record, query));
  }

  async find(query: ArtifactVersionIdentity): Promise<StoredArtifactVersion | undefined> {
    const records = await this.records();
    return records.find(record => sameIdentity(record, query));
  }

  async open(query: ArtifactVersionIdentity): Promise<ArtifactVersionFile> {
    const record = await this.find(query);
    if (!record) throw new ArtifactVersionError("Artifact version not found.", 404);
    const path = join(this.root, `${record.versionId}.bin`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => { throw new ArtifactVersionError("Artifact version is unavailable.", 404); });
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== record.size) throw new ArtifactVersionError("Artifact version is unavailable.", 404);
      return { file, size: record.size, name: basename(record.name), mimeType: record.mimeType };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async removeVersion(versionId: string): Promise<void> {
    await this.serialized(async () => {
      if (!validVersionId(versionId)) return;
      await rm(join(this.root, `${versionId}.json`), { force: true }).catch(() => {});
      await rm(join(this.root, `${versionId}.bin`), { force: true }).catch(() => {});
    });
  }

  /** Deletion is synchronous because the surrounding group deletion is deliberately synchronous. */
  removeConversationsSync(ids: readonly string[]): void {
    if (!this.ensureRootSync()) return;
    const wanted = new Set(ids);
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      const versionId = name.slice(0, -5);
      if (!validVersionId(versionId)) continue;
      let record: unknown;
      try { record = JSON.parse(readFileSync(join(this.root, name), "utf8")); } catch { continue; }
      if (!validRecord(record)) continue;
      const disk = record as DiskRecord;
      if (!wanted.has(disk.conversationId) && !wanted.has(disk.sourceConversationId)) continue;
      rmSync(join(this.root, `${versionId}.json`), { force: true });
      rmSync(join(this.root, `${versionId}.bin`), { force: true });
    }
  }

}
