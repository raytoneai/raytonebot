import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryService } from '../../../src/pi/memories.ts';
import { RoutineStore } from '../../../src/pi/routines.ts';
import { createMcpService } from '../../../src/pi/mcpServers.ts';
import { ApprovalMemory } from '../../../src/pi/approvalMemory.ts';
import { Store } from '../../../control/store.ts';
import { createPiRuntimeController } from '../../../src/pi/piHost.ts';

const dir = mkdtempSync('/tmp/raytone-review-data-');
try {
  for (const file of ['memories.json', 'routines.json', 'mcp.json']) writeFileSync(join(dir, file), '{"existing-data":');
  const memory = createMemoryService({ dataDir: dir });
  assert.equal(memory.state().memories.length, 0);
  memory.add('Review probe only');
  assert.equal(JSON.parse(readFileSync(join(dir, 'memories.json'))).memories.length, 1);
  const routines = new RoutineStore(join(dir, 'routines.json'));
  assert.equal(routines.list().length, 0);
  routines.put({ id: 'new', title: 'Probe', createdAt: 0 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'routines.json'))).routines[0].id, 'new');
  const mcp = createMcpService({ dataDir: dir });
  assert.deepEqual(mcp.list(), []);
  await mcp.save(undefined, { name: 'Probe', url: 'https://example.com/mcp', enabled: false });
  assert.equal(JSON.parse(readFileSync(join(dir, 'mcp.json'))).servers.length, 1);
  console.log('CONFIRMED: corrupted memory/routine/MCP files appear empty and are overwritten by the next save. No network was used.');

  const ctl = join(dir, 'control');
  const store = new Store(ctl);
  mkdirSync(join(ctl, 'store.json'));
  assert.throws(() => store.claim('probe-owner'));
  rmSync(join(ctl, 'store.json'), { recursive: true });
  const retry = store.claim('probe-owner');
  assert.equal(retry.created, false);
  assert.equal(retry.bot.status, 'provisioning');
  assert.equal(new Store(ctl).list().length, 0);
  console.log('CONFIRMED: failed control claim remains in memory; retry returns created=false with a provisioning bot absent from disk.');

  const grantFile = join(dir, 'approvals.json');
  const approvals = new ApprovalMemory(grantFile);
  approvals.add('assistant', 'write');
  mkdirSync(grantFile + '.tmp');
  assert.throws(() => approvals.clear('assistant'));
  assert.equal(approvals.has('assistant', 'write'), false);
  assert.equal(new ApprovalMemory(grantFile).has('assistant', 'write'), true);
  console.log('CONFIRMED: failed approval clear removes the in-memory grant but the grant returns after restart.');

  const mem2 = createMemoryService();
  mem2.add('Always include measurement units');
  assert.match(mem2.noteFor('retry-conversation'), /measurement units/);
  assert.equal(mem2.noteFor('retry-conversation'), undefined);
  const delivered = [];
  const mem3 = createMemoryService();
  mem3.add('Always include measurement units');
  const runtime = createPiRuntimeController({ cwd: dir, dataDir: join(dir, 'runtime'), memory: mem3,
    bridgeFactory: async () => ({ subscribe: () => () => {}, prompt: async text => { delivered.push(text); },
      abort: async () => {}, dispose() {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {} }) });
  try {
    const events = [];
    await runtime.runPrompt({ conversationId: 'retry', requestId: 'invalid-attachment', prompt: 'Read this',
      attachments: [{ scope: 'assistant', path: 'missing.txt' }] }, event => events.push(event));
    assert.ok(events.some(event => event.type === 'run.error'));
    assert.equal(delivered.length, 0);
    await runtime.runPrompt({ conversationId: 'retry', requestId: 'retry', prompt: 'Try again' }, () => {});
    assert.equal(delivered.length, 1);
    assert.ok(!delivered[0].includes('measurement units'));
    console.log('CONFIRMED: missing attachment fails before the bridge receives a prompt; the valid retry never includes saved memory. Host path exercised with a fake bridge.');
  } finally { runtime.dispose(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
