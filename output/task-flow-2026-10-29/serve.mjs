// Disposable UI verification: actual Vite app + actual HTTP host, controlled engine, fictional data.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import config from '../../vite.config.ts';
import { createPiHttpHost } from '../../src/pi/piHost.ts';
import { createConversationStore } from '../../src/pi/conversationStore.ts';
import { createPiEventAdapter } from '../../src/harness/adapters/piAdapter.ts';
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from '../../src/pi/workspaceLayout.ts';
import { ProviderStore } from '../../src/pi/providerStore.ts';
import { project } from '../../src/exported-project.ts';

const root = mkdtempSync(join(tmpdir(), 'raytone-task-flow-'));
const port = Number(process.env.TASK_FLOW_PORT ?? 5194);
const dataDir = join(root, 'data'); mkdirSync(dataDir);
const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, 'workspace') }); ensureWorkspaceLayout(layout);
const providers = structuredClone(project.providers);
providers.defaultProviderId = 'custom-provider';
providers.connections = providers.connections.map(p => p.id === 'custom-provider' ? { ...p, enabled: true, added: true, baseUrl: `http://127.0.0.1:${port}/v1`, auth: { mode: 'none' } } : { ...p, enabled: false });
new ProviderStore(join(`${dataDir}.provider-secrets`, 'providers.enc')).save(providers, {}, [], 0);
writeFileSync(join(layout.agents.assistant, 'source.txt'), 'Fictional attachment for recovery verification.');
const store = createConversationStore(dataDir);
const seed = (id, title, error, reply = '报告已完成，结果可以继续查看和使用。') => {
  const runId = `run-${id}`;
  store.begin(id, 'assistant', title);
  store.saveTurn(id, { runId, harness: 'pi', prompt: title, attachments: [{ scope: 'assistant', path: 'source.txt', name: 'source.txt' }] });
  const adapter = createPiEventAdapter({ runId }); adapter.startUserMessage(title);
  adapter.apply({ type: 'message_start', message: { role: 'assistant' } });
  if (!error) adapter.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: reply } });
  adapter.apply({ type: 'message_end', message: { role: 'assistant', stopReason: error ? 'error' : 'stop', ...(error ? { errorMessage: error } : {}) } }); adapter.finish();
  for (const event of adapter.events) store.append(id, event); store.flush(id);
};
seed('ready-report', '已完成的竞品报告');
seed('model-repair', '根据附件继续整理报告', 'The configured model service has no API key.');
seed('mcp-repair', '继续同步文档', 'The MCP server rejected the token.');
seed('login-repair', '继续查看已登录网站', 'Please log in to continue.');
seed('long-report', '长报告可见性验证', undefined, Array.from({length: 30}, (_, i) => `第 ${i + 1} 段：这是用于验证实际阅读位置的本地示例。结果只有出现在阅读区域中才应清除提示。`).join('\n\n'));
const now = Date.now();
writeFileSync(join(dataDir, 'routines.json'), JSON.stringify({ routines: [{ id: 'missed-check', botId: 'assistant', title: '错过的每日检查', instructions: '核对公开资料。', schedule: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: false, createdAt: now - 86400000, revision: 1, conversationId: 'routine-missed-check', failures: 0, lastSkipped: { at: now - 3600000, detectedAt: now, reason: 'offline' } }] }));
const calls = [];
const bridgeFactory = async ({ approvalGate }) => {
  let emit = () => {}; let abort; let selected = {};
  return {
    subscribe(fn) { emit = fn; return () => {}; }, configure: async value => { selected = value; }, state: async () => ({ ...selected, models: [], tools: [] }), newSession: async () => {}, dispose() {},
    async prompt(prompt, attachments) {
      calls.push({ prompt, attachments });
      writeFileSync('output/task-flow-2026-10-29/calls.json', JSON.stringify(calls, null, 2));
      emit({ type: 'message_start', message: { role: 'assistant' } });
      if (prompt.includes('等待审批')) {
        emit({ type: 'tool_execution_start', toolCallId: 'approval-check', toolName: 'write', args: { path: 'result.txt' } });
        await approvalGate.wait('approval-check', 'write', { path: 'result.txt' }, new AbortController().signal);
        emit({ type: 'tool_execution_end', toolCallId: 'approval-check', toolName: 'write', result: { content: [{ type: 'text', text: 'Controlled write completed.' }] } });
      }
      await new Promise(resolve => { abort = resolve; setTimeout(resolve, prompt.includes('遮挡验收') ? 2500 : 300); });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '配置检查后的任务已继续，附件保留；这是本地受控引擎的验证结果。' } });
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    }, abort: async () => abort?.(),
  };
};
const host = createPiHttpHost({ cwd: layout.agents.assistant, dataDir, layout, appRoot: process.cwd(), bridgeFactory, routineClock: false });
const server = await createServer({ ...config, configFile: false, server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [...config.plugins.filter(plugin => plugin.name !== 'agentcanvas-pi-runtime'), { name: 'task-flow-test-host', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/__agentcanvas/pi')) return next(); void host.handle(req, res).then(handled => { if (!handled) next(); }).catch(next);
  }); } }] });
await server.listen();
writeFileSync('output/task-flow-2026-10-29/test-env.json', JSON.stringify({ root, dataDir, workRoot: join(root, 'workspace') }, null, 2));
console.log(`Isolated UI verification: http://127.0.0.1:${port}/`);
process.on('SIGTERM', async () => { host.dispose(); await server.close(); process.exit(0); });
