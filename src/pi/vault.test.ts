import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVaultOrigin, VaultError, VaultStore } from './vault.ts';

const login = { label: 'Work account', origin: 'https://login.example', username: 'private-user@example.test', password: '  私密 password\t\n ', enabled: true };
const status = (expected: number) => (error: unknown) => error instanceof VaultError && error.status === expected && !error.message.includes(login.password) && !error.message.includes(login.username);
function diskTest(run: (file: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'raytone-vault-'));
  try { run(join(dir, 'vault', 'logins.enc'), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('Vault encrypts the complete record and restores exact secrets after restart', () => diskTest(file => {
  const first = new VaultStore(file);
  const view = first.save(login, 0);
  assert.equal(view.revision, 1);
  assert.equal(view.items[0].usernameHint, '••••');
  for (const value of [login.username, login.password]) assert.ok(!JSON.stringify(view).includes(value));
  const encrypted = readFileSync(file, 'utf8');
  for (const value of [login.username, login.label, login.origin, '私密']) assert.ok(!encrypted.includes(value));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
  assert.equal(statSync(join(file, '..', 'master.key')).mode & 0o777, 0o600);
  const restart = new VaultStore(file);
  assert.deepEqual(restart.view(), view);
  assert.deepEqual(restart.resolve(view.items[0].id, 1, login.origin), { username: login.username, password: login.password });
  view.items[0].label = 'mutated';
  assert.equal(first.view().items[0].label, login.label);
}));

test('Vault edits preserve omitted credentials and reject explicit empty credentials', () => {
  const store = new VaultStore();
  const initial = store.save(login, 0);
  const id = initial.items[0].id;
  for (const changed of [{ username: '' }, { password: '' }, { username: null }, { password: null }]) assert.throws(() => store.save({ ...login, id, ...changed }, 1), status(400));
  const edited = store.save({ id, label: 'Renamed', origin: login.origin, enabled: true }, 1);
  assert.equal(edited.items[0].version, 2);
  assert.deepEqual(store.resolve(id, 2, login.origin), { username: login.username, password: login.password });
  assert.throws(() => store.save(login, 1), status(409));
});

test('Vault binds enabled logins to exact origin and version, including port and subdomain', () => {
  const store = new VaultStore();
  const id = store.save(login, 0).items[0].id;
  for (const origin of ['https://other.example', 'https://sub.login.example', 'https://login.example:8443']) assert.throws(() => store.resolve(id, 1, origin), status(409));
  assert.throws(() => store.resolve(id, 2, login.origin), status(409));
  store.save({ id, label: login.label, origin: login.origin, enabled: false }, 1);
  assert.throws(() => store.resolve(id, 2, login.origin), status(409));
  store.remove(id, 2);
  assert.throws(() => store.resolve(id, 2, login.origin), status(409));
  assert.throws(() => store.remove(id, 3), status(404));
});

test('Vault rejects stale instances and resolves revocation from the disk', () => diskTest(file => {
  const store = new VaultStore(file);
  const id = store.save(login, 0).items[0].id;
  const second = new VaultStore(file);
  second.save({ id, label: login.label, origin: login.origin, enabled: false }, 1);
  assert.throws(() => store.save(login, 1), status(409));
  assert.throws(() => store.resolve(id, 1, login.origin), status(409));
  second.remove(id, 2);
  assert.throws(() => store.resolve(id, 1, login.origin), status(409));
  assert.equal(new VaultStore(file).view().items.length, 0);
}));

test('Vault rejects a second empty instance and a live process lock', () => diskTest(file => {
  const first = new VaultStore(file), second = new VaultStore(file);
  first.save(login, 0);
  assert.throws(() => second.save(login, 0), status(409));
  writeFileSync(`${file}.lock`, '', { mode: 0o600 });
  assert.throws(() => first.save(login, 1), status(409));
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), '');
}));

test('Vault views refresh other-process edits and allow a deliberate conflict reload', () => diskTest(file => {
  const first = new VaultStore(file), second = new VaultStore(file);
  const created = second.save(login, 0);
  assert.deepEqual(first.view(), created, 'a file appearing after construction becomes visible');
  const id = created.items[0].id;
  const changed = second.save({ id, label: 'Changed elsewhere', origin: login.origin, enabled: true }, 1);
  assert.throws(() => first.save({ ...login, id }, 1), status(409));
  const refreshed = first.view();
  assert.deepEqual(refreshed, changed);
  assert.equal(first.save({ id, label: 'Reloaded edit', origin: login.origin, enabled: true }, refreshed.revision).revision, 3);
  rmSync(file);
  assert.throws(() => first.view(), status(503));
  assert.throws(() => first.save(login, 3), status(503));
}));

test('Vault origin changes require explicitly supplied username and password', () => {
  const store = new VaultStore();
  const id = store.save(login, 0).items[0].id;
  const input = { id, label: login.label, origin: 'https://different.example', enabled: true };
  for (const partial of [{}, { username: 'new-user' }, { password: 'new-password' }]) assert.throws(() => store.save({ ...input, ...partial }, 1), status(400));
  assert.equal(store.view().revision, 1);
  assert.deepEqual(store.resolve(id, 1, login.origin), { username: login.username, password: login.password });
  const rebound = store.save({ ...input, username: 'new-user', password: 'new-password' }, 1);
  assert.throws(() => store.resolve(id, 1, login.origin), status(409));
  assert.deepEqual(store.resolve(id, rebound.items[0].version, input.origin), { username: 'new-user', password: 'new-password' });
});

test('Vault origin normalization accepts only bare HTTPS origins', () => {
  assert.equal(normalizeVaultOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
  assert.equal(normalizeVaultOrigin('https://example.com:8443'), 'https://example.com:8443');
  for (const origin of [null, 'http://localhost', 'http://127.0.0.1:5188', 'https://a.example/login', 'https://a.example/.', 'https://a.example?', 'https://a.example#', 'https://user:pass@a.example', 'https://@a.example', ' https://a.example', 'https://a.example\n', 'https://a.example\\', 'https://a.example/%2e', 'https://a.example\t']) assert.throws(() => normalizeVaultOrigin(origin), status(400));
});

test('Vault bounds inputs and record count without leaking rejected secrets', () => {
  const store = new VaultStore();
  for (const input of [null, [], { ...login, label: 'x'.repeat(121) }, { ...login, username: 'x'.repeat(513) }, { ...login, password: 'x'.repeat(8193) }, { ...login, enabled: 'true' }, { ...login, cardNumber: 'fake-card' }, { ...login, id: 'unknown' }]) assert.throws(() => store.save(input, 0), status(400));
  for (let revision = 0; revision < 100; revision++) store.save(login, revision);
  assert.throws(() => store.save(login, 100), status(400));
  assert.equal(store.view().items.length, 100);
});

test('Vault refuses damaged ciphertext, missing keys and changed keys without overwriting', () => {
  for (const damage of ['ciphertext', 'lost-key', 'wrong-key', 'malformed-envelope', 'large-file']) diskTest(file => {
    const store = new VaultStore(file);
    const id = store.save(login, 0).items[0].id;
    const key = join(file, '..', 'master.key');
    if (damage === 'ciphertext') {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      const data = Buffer.from(envelope.data, 'base64'); data[0] ^= 1;
      envelope.data = data.toString('base64'); writeFileSync(file, JSON.stringify(envelope));
    } else if (damage === 'lost-key') rmSync(key);
    else if (damage === 'wrong-key') writeFileSync(key, randomBytes(32));
    else if (damage === 'large-file') writeFileSync(file, Buffer.alloc(5_000_001));
    else writeFileSync(file, JSON.stringify({ version: 1, iv: [], tag: null, data: {} }));
    const original = readFileSync(file);
    const broken = new VaultStore(file);
    assert.throws(() => broken.view(), status(503));
    assert.throws(() => broken.save(login, 0), status(503));
    assert.throws(() => store.save(login, 1), status(503));
    assert.throws(() => store.resolve(id, 1, login.origin), status(503));
    assert.deepEqual(readFileSync(file), original);
  });
});

test('Vault validates authenticated plaintext shape, entries and uniqueness', () => diskTest(file => {
  const store = new VaultStore(file);
  const item = store.save(login, 0).items[0];
  const { usernameHint: _hint, ...metadata } = item;
  const full = { ...metadata, username: login.username, password: login.password };
  const dataCases = [null, [], { revision: 0, items: [] }, { revision: 1, items: [full, full] }, { revision: 1, items: [{ ...full, version: 2 }] }, { revision: 1, items: [{ ...full, password: '' }] }, { revision: 1, items: [{ ...full, origin: 'https://example.com/path' }] }, { revision: 1, items: [{ ...full, extra: true }] }];
  for (const data of dataCases) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', readFileSync(join(file, '..', 'master.key')), iv);
    cipher.setAAD(Buffer.from('raytonebot.vault.v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    writeFileSync(file, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }));
    assert.throws(() => new VaultStore(file).view(), status(503));
    assert.throws(() => store.save(login, 1), status(503));
  }
}));

test('Vault refuses symlinks, hardlinks and permissive files or directories', () => {
  for (const damage of ['file-symlink', 'key-symlink', 'dangling-symlink', 'directory-symlink', 'file-hardlink', 'key-hardlink', 'file-mode', 'key-mode', 'directory-mode']) diskTest((file, dir) => {
    new VaultStore(file).save(login, 0);
    const key = join(file, '..', 'master.key');
    if (damage === 'file-symlink' || damage === 'key-symlink') {
      const path = damage === 'file-symlink' ? file : key;
      const original = readFileSync(path); rmSync(path); const target = join(dir, 'target'); writeFileSync(target, original, { mode: 0o600 }); symlinkSync(target, path);
    } else if (damage === 'dangling-symlink') { rmSync(file); symlinkSync(join(dir, 'missing'), file); }
    else if (damage === 'directory-symlink') { rmSync(join(dir, 'vault'), { recursive: true }); mkdirSync(join(dir, 'other'), { mode: 0o700 }); symlinkSync(join(dir, 'other'), join(dir, 'vault')); }
    else if (damage === 'file-hardlink' || damage === 'key-hardlink') linkSync(damage === 'file-hardlink' ? file : key, join(dir, 'linked'));
    else chmodSync(damage === 'file-mode' ? file : damage === 'key-mode' ? key : join(dir, 'vault'), 0o755);
    const broken = new VaultStore(file);
    assert.throws(() => broken.view(), status(503));
    assert.throws(() => broken.save(login, 0), status(503));
  });
});

test('Vault supports a separate environment master key and fails closed on invalid or changed values', () => diskTest(file => {
  const prior = process.env.RAYTONEBOT_VAULT_MASTER_KEY;
  try {
    process.env.RAYTONEBOT_VAULT_MASTER_KEY = 'f'.repeat(64);
    const id = new VaultStore(file).save(login, 0).items[0].id;
    assert.deepEqual(new VaultStore(file).resolve(id, 1, login.origin), { username: login.username, password: login.password });
    for (const key of ['a'.repeat(64), '', 'bad-key']) {
      process.env.RAYTONEBOT_VAULT_MASTER_KEY = key;
      assert.throws(() => new VaultStore(file).view(), status(503));
    }
  } finally { if (prior === undefined) delete process.env.RAYTONEBOT_VAULT_MASTER_KEY; else process.env.RAYTONEBOT_VAULT_MASTER_KEY = prior; }
}));
