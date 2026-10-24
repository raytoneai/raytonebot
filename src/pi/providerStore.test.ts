import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../exported-project.ts';
import { piRuntimeConfigurationForProvider } from './piProviderSync.ts';
import { ProviderStore } from './providerStore.ts';
import { createPiHttpHost } from './piHost.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { scrubSecretEnv } from './runtime/childEnv.ts';

test('provider save rejects a run started while its request body is still arriving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtb-provider-save-race-'));
  let releaseBody!: () => void, readingBody!: () => void, releaseRun!: () => void, startedRun!: () => void;
  const bodyReady = new Promise<void>(resolve => { releaseBody = resolve; });
  const reading = new Promise<void>(resolve => { readingBody = resolve; });
  const runReady = new Promise<void>(resolve => { releaseRun = resolve; });
  const started = new Promise<void>(resolve => { startedRun = resolve; });
  let active = false, disposedDuringRun = false;
  const host = createPiHttpHost({ cwd: dir, dataDir: join(dir, 'data'), browser: false, routineClock: false,
    bridgeFactory: async () => ({
      configure: async () => {}, state: async () => ({ models: [], tools: [] }),
      prompt: async () => { active = true; startedRun(); await runReady; active = false; },
      abort: async () => { releaseRun(); }, dispose() { if (active) disposedDuringRun = true; },
      newSession: async () => {}, subscribe: () => () => {},
    }),
  });
  const response = { statusCode: 0, headersSent: false, body: '',
    setHeader() {}, writeHead(status: number) { this.statusCode = status; this.headersSent = true; },
    end(body: string) { this.body = body; },
  };
  const request = { method: 'POST', url: '/__agentcanvas/pi/providers', headers: {},
    async *[Symbol.asyncIterator]() {
      readingBody(); await bodyReady;
      yield Buffer.from(JSON.stringify({ providers: project.providers, keys: {}, revision: 0 }));
    },
  };
  let run: Promise<void> | undefined;
  try {
    const saving = host.handle(request as IncomingMessage, response as unknown as ServerResponse);
    await reading;
    run = host.controller.runPrompt({ conversationId: 'race', prompt: 'hello', requestId: 'save-race' }, () => {});
    await started;
    releaseBody(); await saving;
    assert.equal(response.statusCode, 409);
    assert.equal(disposedDuringRun, false, 'a rejected save must leave the running bridge intact');
    assert.equal(host.controller.health().activeRuns, 1);
    const view = new ProviderStore(join(`${dir}/data.provider-secrets`, 'providers.enc')).view();
    assert.equal(view.revision, 0, 'rejected changes must not be persisted');
  } finally {
    releaseBody(); releaseRun(); await run;
    host.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});

test('provider save survives restart without exposing secrets and binds credentials to endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtb-providers-'));
  const file = join(dir, 'secrets', 'providers.enc');
  const providers = structuredClone(project.providers);
  const provider = providers.connections.find(p => p.id === 'gemini')!;
  provider.enabled = true; providers.defaultProviderId = provider.id;
  const definition = piRuntimeConfigurationForProvider(provider).providerDefinition!;
  try {
    const first = new ProviderStore(file);
    const view = first.save(providers, { gemini: 'fake-private-test-key' }, [], 0);
    assert.equal(view.revision, 1);
    assert.equal(view.credentials.gemini, true);
    assert.ok(!JSON.stringify(view).includes('fake-private-test-key'));
    assert.ok(!readFileSync(file, 'utf8').includes('fake-private-test-key'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700);
    const next = new ProviderStore(file);
    assert.equal(next.resolve(definition), 'fake-private-test-key');
    assert.equal(next.resolve({ ...definition, baseUrl: 'https://other.example/v1' }), undefined);
    assert.throws(() => next.save(providers, {}, [], 0), /changed/);
    const saved = next.save(providers, {}, [], 1);
    assert.equal(next.resolve(definition), 'fake-private-test-key');
    next.save(providers, {}, ['gemini'], saved.revision);
    assert.equal(new ProviderStore(file).resolve(definition), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP save reloads configuration and key into fresh turns after restart; deleting clears old engine credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtb-provider-http-'));
  const dataDir = join(dir, 'data');
  const providers = structuredClone(project.providers);
  const provider = providers.connections.find(p => p.id === 'gemini')!;
  provider.enabled = true; providers.defaultProviderId = provider.id;
  const definition = piRuntimeConfigurationForProvider(provider).providerDefinition!;
  const received: any[] = [];
  const start = async () => {
    const host = createPiHttpHost({ cwd: dir, dataDir, browser: false, routineClock: false, bridgeFactory: async () => {
      let config: any = {};
      return { configure: async value => { config = value; received.push(value); }, state: async () => ({ provider: config.provider, model: config.model, models: [], tools: [] }),
        prompt: async () => {}, abort: async () => {}, dispose() {}, newSession: async () => {}, subscribe: () => () => {} };
    } });
    const server = createServer((req, res) => { void host.handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}/__agentcanvas/pi`;
    return { host, url, close: async () => { host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  };
  let service = await start();
  const post = (path: string, body: unknown, headers = {}) => fetch(service.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const body = { providers, keys: { gemini: 'private-http-test-key' }, revision: 0 };
    assert.equal((await post('/providers', body, { origin: 'https://evil.example' })).status, 403);
    const saved = await post('/providers', body);
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.ok(!(await saved.text()).includes('private-http-test-key'));
    await service.close(); service = await start();
    const view = await (await fetch(service.url + '/providers')).json();
    assert.equal(view.providers.defaultProviderId, 'gemini'); assert.equal(view.credentials.gemini, true);
    assert.equal((await post('/config', { conversationId: 'restored', provider: 'gemini', model: provider.defaultModel, providerDefinition: definition })).status, 200);
    assert.equal(received.at(-1).apiKey, 'private-http-test-key');
    // Arbitrary /config endpoint changes must not forward a saved key.
    await post('/config', { conversationId: 'other', provider: 'gemini', model: provider.defaultModel, providerDefinition: { ...definition, baseUrl: 'https://other.example/v1' } });
    assert.equal(received.at(-1).apiKey, undefined); assert.equal(received.at(-1).clearApiKey, true);
    await post('/providers', { providers, keys: {}, removeKeys: ['gemini'], revision: view.revision });
    await post('/config', { conversationId: 'restored', provider: 'gemini', model: provider.defaultModel, providerDefinition: definition });
    assert.equal(received.at(-1).apiKey, undefined); assert.equal(received.at(-1).clearApiKey, true);
    assert.equal((await post('/providers', body)).status, 409);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('master key is stripped from agent environments; env credentials cannot be redirected', () => {
  assert.deepEqual(scrubSecretEnv({ PATH: '/bin', RAYTONEBOT_CREDENTIAL_MASTER_KEY: 'fake-master' }), { PATH: '/bin' });
  const store = new ProviderStore();
  const provider = project.providers.connections.find(p => p.id === 'gemini')!;
  const definition = piRuntimeConfigurationForProvider(provider).providerDefinition!;
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-env-key';
  try {
    assert.equal(store.environmentKey(definition), 'fake-env-key');
    assert.equal(store.environmentKey({ ...definition, baseUrl: 'https://other.example' }), undefined);
  } finally { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; }
});

test('damaged credentials fail closed and symlinks are rejected without overwriting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtb-providers-bad-'));
  const file = join(dir, 'secrets', 'providers.enc');
  try {
    new ProviderStore(file).save(project.providers, {}, [], 0);
    writeFileSync(file, 'damaged', { mode: 0o600 });
    const broken = new ProviderStore(file);
    assert.throws(() => broken.view(), /unavailable/);
    assert.throws(() => broken.save(project.providers, {}, [], 0), /unavailable/);
    assert.equal(readFileSync(file, 'utf8'), 'damaged');
    rmSync(file); symlinkSync(join(dir, 'target'), file);
    assert.throws(() => new ProviderStore(file).save(project.providers, {}, [], 0), /unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
