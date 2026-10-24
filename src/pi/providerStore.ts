import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { project } from '../exported-project.ts';
import type { AgentFrontendProject } from '../schema/agentuxConfig.ts';
import { normalizeProviderSettings, restoreProviderSettings, serializeProviderSettings } from '../runtime/providerSettings.ts';
import { piRuntimeConfigurationForProvider } from './piProviderSync.ts';
import type { PiProviderDefinition } from './piClient.ts';
import { modelsUrl } from './providerProbe.ts';

type Providers = AgentFrontendProject['providers'];
export type ProviderStoreView = { revision: number; providers?: Providers; credentials: Record<string, boolean> };
type Data = { revision: number; providers?: Providers; keys: Record<string, string> };
export class ProviderStoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** The endpoint, protocol and auth mode are part of a credential's identity, never only its ID. */
export function providerBinding(definition: PiProviderDefinition): string {
  const url = modelsUrl(definition.baseUrl);
  return JSON.stringify([definition.id, definition.protocol, url.href, definition.authMode]);
}

/** Host-only vault. No key, key fragment, ciphertext or master key is exposed in view(). */
export class ProviderStore {
  private data: Data = { revision: 0, keys: {} };
  private error?: Error;
  private readonly file?: string;
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      if (!existsSync(file)) { try { lstatSync(file); throw new Error(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } return; }
      this.checkDirectory();
      const envelope = JSON.parse(this.readPrivate(file).toString('utf8'));
      if (envelope.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey(false), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('raytonebot.providers.v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as Data;
      if (!Number.isSafeInteger(data.revision) || data.revision < 1 || !data.keys || typeof data.keys !== 'object' || Array.isArray(data.keys)) throw new Error();
      data.providers = this.cleanProviders(data.providers);
      for (const [binding, key] of Object.entries(data.keys)) {
        if (binding.length > 5000 || !this.validKey(key)) throw new Error();
      }
      this.data = data;
    } catch { this.error = new ProviderStoreError('Provider storage unavailable. Original files were preserved; repair storage before saving.', 503); }
  }
  view(): ProviderStoreView {
    if (this.error) throw this.error;
    return { revision: this.data.revision, providers: structuredClone(this.data.providers), credentials: Object.fromEntries(
      (this.data.providers?.connections ?? []).map(p => [p.id, Boolean(this.data.keys[providerBinding(piRuntimeConfigurationForProvider(p).providerDefinition!)])])) };
  }
  resolve(definition: PiProviderDefinition): string | undefined {
    this.view();
    if (definition.authMode === 'none') return undefined;
    return this.data.keys[providerBinding(definition)];
  }
  /** Environment credentials may only go to a saved binding or its built-in default endpoint. */
  environmentKey(definition: PiProviderDefinition): string | undefined {
    if (definition.authMode === 'none' || !definition.apiKeyEnvVar) return undefined;
    this.view();
    const trusted = (this.data.providers ?? project.providers).connections.find(p => p.id === definition.id);
    if (!trusted) return undefined;
    const expected = piRuntimeConfigurationForProvider(trusted).providerDefinition!;
    if (expected.apiKeyEnvVar !== definition.apiKeyEnvVar || providerBinding(expected) !== providerBinding(definition)) return undefined;
    return process.env[definition.apiKeyEnvVar]?.trim() || undefined;
  }
  save(value: unknown, updates: unknown, removals: unknown, revision: unknown): ProviderStoreView {
    this.view();
    if (revision !== this.data.revision) throw new ProviderStoreError('Provider settings changed in another page. Reload before saving.', 409);
    const providers = this.cleanProviders(value);
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) || !Array.isArray(removals) || removals.some(id => typeof id !== 'string')) throw new ProviderStoreError('Invalid credential changes.');
    const keys = { ...this.data.keys };
    const ids = new Set(providers.connections.map(p => p.id));
    if ([...Object.keys(updates), ...removals].some(id => !ids.has(id))) throw new ProviderStoreError('Unknown model service.');
    for (const p of providers.connections) {
      const binding = providerBinding(piRuntimeConfigurationForProvider(p).providerDefinition!);
      if (removals.includes(p.id)) delete keys[binding];
      const key = (updates as Record<string, unknown>)[p.id];
      if (key === undefined || key === '') continue; // Empty input keeps the stored credential.
      if (removals.includes(p.id) || p.auth.mode === 'none' || !this.validKey(key)) throw new ProviderStoreError('Invalid API key.');
      keys[binding] = key.trim();
    }
    const next: Data = { revision: this.data.revision + 1, providers, keys };
    if (Buffer.byteLength(JSON.stringify(next)) > 1_000_000) throw new ProviderStoreError("Provider storage size limit reached.");
    if (this.file) {
      let temporary: string | undefined;
      let lock: number | undefined;
      const lockFile = `${this.file}.lock`;
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); this.checkDirectory();
        try { lock = openSync(lockFile, "wx", 0o600); } catch { throw new ProviderStoreError("Provider storage is busy. Retry after the other save completes.", 409); }
        // Re-read the disk revision to reject writes from another host process as well.
        if (existsSync(this.file)) {
          const disk = new ProviderStore(this.file);
          if (disk.view().revision !== this.data.revision) throw new ProviderStoreError('Provider settings changed. Reload before saving.', 409);
        }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.masterKey(true), iv);
        cipher.setAAD(Buffer.from('raytonebot.providers.v1'));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
        temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') })); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, this.file); temporary = undefined;
      } catch (error) {
        if (error instanceof ProviderStoreError) throw error;
        throw new ProviderStoreError('Provider storage unavailable. Changes were not saved.', 503);
      } finally { if (lock !== undefined) { closeSync(lock); unlinkSync(lockFile); } if (temporary) try { unlinkSync(temporary); } catch { /* Best effort; contains ciphertext only. */ } }
    }
    this.data = next;
    return this.view();
  }
  private validKey(key: unknown): key is string { return typeof key === 'string' && key.trim().length > 0 && key.length <= 8192 && !/[\x00-\x20\x7f]/.test(key) && !/^<.*>$/.test(key); }
  private cleanProviders(value: unknown): Providers {
    try {
      const source = value as Providers;
      if (!source || !Array.isArray(source.connections) || source.connections.length > 100 || new Set(source.connections.map(p => p.id)).size !== source.connections.length) throw new Error();
      const cleaned = normalizeProviderSettings(restoreProviderSettings(project.providers, serializeProviderSettings(project.providers, source)));
      if (!cleaned.connections.some(p => p.enabled && p.id === source.defaultProviderId)) throw new Error();
      for (const p of cleaned.connections) modelsUrl(p.baseUrl);
      return cleaned;
    } catch { throw new ProviderStoreError('Invalid provider settings.'); }
  }
  private checkDirectory() {
    const stat = lstatSync(dirname(this.file!));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
  }
  private readPrivate(file: string): Buffer {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 2_000_000 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
  private masterKey(create: boolean): Buffer {
    const supplied = process.env.RAYTONEBOT_CREDENTIAL_MASTER_KEY;
    if (supplied) { if (!/^[a-f\d]{64}$/i.test(supplied)) throw new Error(); return Buffer.from(supplied, 'hex'); }
    const file = join(dirname(this.file!), 'master.key');
    if (!existsSync(file) && create && !existsSync(this.file!)) {
      const fd = openSync(file, 'wx', 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const key = this.readPrivate(file);
    if (key.length !== 32) throw new Error();
    return key;
  }
}
