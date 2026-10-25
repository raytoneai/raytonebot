import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VaultLoginView, VaultState } from './vaultTypes.ts';

type Login = Omit<VaultLoginView, 'usernameHint'> & { username: string; password: string };
type Data = { revision: number; items: Login[] };
const AAD = Buffer.from('raytonebot.vault.v1');
const MAX_FILE = 5_000_000;
const unavailable = () => new VaultError('Vault storage unavailable. Original files were preserved; repair storage before saving.', 503);
const conflict = () => new VaultError('Vault changed. Reload before saving.', 409);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const secret = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const validLabel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);

export class VaultError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'VaultError'; this.status = status; }
}

/** Bare HTTPS origin only. Paths, credentials and URL parser whitespace repairs are rejected. */
export function normalizeVaultOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(value) || !/^https:\/\/[^/?#\\]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.includes('@')) throw new Error();
    return url.origin;
  } catch { throw new VaultError('Use a bare HTTPS origin, such as https://example.com.'); }
}

/** Host-only login secrets. Public views contain no credential characters. */
export class VaultStore {
  private data: Data = { revision: 0, items: [] };
  private error?: VaultError;
  private readonly file?: string;
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      if (this.present(dirname(file))) this.checkDirectory();
      if (this.present(file)) this.data = this.readData();
    } catch { this.error = unavailable(); }
  }
  view(): VaultState {
    if (this.error) throw this.error;
    if (this.file) {
      try {
        if (this.present(dirname(this.file))) this.checkDirectory();
        if (this.present(this.file)) this.data = this.readData();
        else if (this.data.revision !== 0) throw new Error();
      } catch { throw unavailable(); }
    }
    return { revision: this.data.revision, items: this.data.items.map(({ username: _username, password: _password, ...item }) => ({ ...item, usernameHint: '••••' })) };
  }
  save(input: unknown, revision: unknown): VaultState {
    this.checkRevision(revision);
    if (!record(input) || Object.keys(input).some(key => !['id', 'label', 'origin', 'username', 'password', 'enabled'].includes(key)) || !validLabel(input.label) || typeof input.enabled !== 'boolean') throw new VaultError('Invalid Vault login.');
    const origin = normalizeVaultOrigin(input.origin);
    if (input.id !== undefined && !validId(input.id)) throw new VaultError('Invalid Vault login.');
    const previous = this.data.items.find(item => item.id === input.id);
    if (input.id !== undefined && !previous) throw new VaultError('Vault login no longer exists.', 404);
    if (!previous && this.data.items.length >= 100) throw new VaultError('Vault supports up to 100 logins.');
    if (previous && previous.origin !== origin && (input.username === undefined || input.password === undefined)) throw new VaultError('Enter both username and password again when changing the login origin.');
    const username = input.username === undefined ? previous?.username : input.username;
    const password = input.password === undefined ? previous?.password : input.password;
    if (!secret(username, 512) || !secret(password, 8192)) throw new VaultError('A username and password within the size limits are required.');
    const now = Date.now();
    const login: Login = { id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, label: input.label.trim(), origin, username, password, enabled: input.enabled, createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, previous?.updatedAt ?? now) };
    return this.commit({ revision: this.data.revision + 1, items: previous ? this.data.items.map(item => item.id === login.id ? login : item) : [...this.data.items, login] });
  }
  remove(id: string, revision: unknown): VaultState {
    this.checkRevision(revision);
    if (!validId(id) || !this.data.items.some(item => item.id === id)) throw new VaultError('Vault login no longer exists.', 404);
    return this.commit({ revision: this.data.revision + 1, items: this.data.items.filter(item => item.id !== id) });
  }
  resolve(id: string, version: number, origin: string): { username: string; password: string } {
    // Refresh at the use boundary: another process may have edited, disabled or deleted it.
    this.view();
    const normalized = normalizeVaultOrigin(origin);
    const item = this.data.items.find(item => item.id === id);
    if (!item || !item.enabled || item.version !== version || item.origin !== normalized) throw new VaultError('Vault login is unavailable or its authorization changed.', 409);
    return { username: item.username, password: item.password };
  }
  private checkRevision(revision: unknown) {
    this.view();
    if (revision !== this.data.revision) throw conflict();
    if (this.data.revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
  }
  private commit(next: Data): VaultState {
    if (this.file) {
      let temporary: string | undefined;
      let lock: number | undefined;
      const lockFile = `${this.file}.lock`;
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        this.checkDirectory();
        try { lock = openSync(lockFile, 'wx', 0o600); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultError('Vault storage is busy. Retry after the other save completes.', 409);
          throw error;
        }
        let disk: { revision: number };
        try { disk = this.present(this.file) ? this.readData() : { revision: 0 }; } catch { throw unavailable(); }
        // A removed store is not a fresh store when this instance has already loaded data.
        if (disk.revision !== this.data.revision) throw conflict();
        const key = this.masterKey(disk.revision === 0);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(AAD);
        const plaintext = JSON.stringify(next);
        if (Buffer.byteLength(plaintext) > 3_000_000) throw new VaultError('Vault storage size limit reached.');
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        temporary = `${this.file}.${randomBytes(12).toString('hex')}.tmp`;
        const fd = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(temporary, this.file); temporary = undefined;
        const directory = openSync(dirname(this.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw unavailable();
      } finally {
        if (temporary) try { unlinkSync(temporary); } catch { /* Ciphertext-only temporary file. */ }
        if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockFile); } catch { /* Never remove a lock we did not acquire. */ } }
      }
    }
    this.data = next;
    return this.view();
  }
  private readData(): Data {
    this.checkDirectory();
    const envelope: unknown = JSON.parse(this.readPrivate(this.file!, MAX_FILE).toString('utf8'));
    if (!record(envelope) || Object.keys(envelope).sort().join(',') !== 'data,iv,tag,version' || envelope.version !== 1) throw new Error();
    const decode = (value: unknown, size?: number) => {
      if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
      const buffer = Buffer.from(value, 'base64');
      if (buffer.toString('base64') !== value || (size !== undefined && buffer.length !== size)) throw new Error();
      return buffer;
    };
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey(false), decode(envelope.iv, 12));
    decipher.setAAD(AAD); decipher.setAuthTag(decode(envelope.tag, 16));
    const data: unknown = JSON.parse(Buffer.concat([decipher.update(decode(envelope.data)), decipher.final()]).toString('utf8'));
    if (!record(data) || Object.keys(data).sort().join(',') !== 'items,revision' || !positive(data.revision) || !Array.isArray(data.items) || data.items.length > 100) throw new Error();
    const ids = new Set<string>();
    for (const item of data.items) {
      if (!record(item) || Object.keys(item).sort().join(',') !== 'createdAt,enabled,id,label,origin,password,updatedAt,username,version' || !validId(item.id) || ids.has(item.id) || !positive(item.version) || item.version > data.revision || !validLabel(item.label) || normalizeVaultOrigin(item.origin) !== item.origin || !secret(item.username, 512) || !secret(item.password, 8192) || typeof item.enabled !== 'boolean' || !positive(item.createdAt) || !positive(item.updatedAt) || item.updatedAt < item.createdAt) throw new Error();
      ids.add(item.id);
    }
    return data as Data;
  }
  private present(file: string): boolean {
    try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private checkDirectory() {
    const stat = lstatSync(dirname(this.file!));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
  }
  private readPrivate(file: string, limit: number): Buffer {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > limit || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
      let total = 0;
      while (total < buffer.length) { const count = readSync(fd, buffer, total, buffer.length - total, null); if (!count) break; total += count; }
      if (total !== stat.size) throw new Error();
      return buffer.subarray(0, total);
    } finally { closeSync(fd); }
  }
  private masterKey(create: boolean): Buffer {
    const supplied = process.env.RAYTONEBOT_VAULT_MASTER_KEY;
    if (supplied !== undefined) {
      if (!/^[a-f\d]{64}$/i.test(supplied)) throw new Error();
      return Buffer.from(supplied, 'hex');
    }
    const file = join(dirname(this.file!), 'master.key');
    if (!this.present(file) && create) {
      const fd = openSync(file, 'wx', 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const key = this.readPrivate(file, 32);
    if (key.length !== 32) throw new Error();
    return key;
  }
}
