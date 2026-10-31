// One-off acceptance: the existing enabled model, isolated conversations/files, no IM or routines.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProviderStore } from '../../src/pi/providerStore.ts';
import { BotConfigStore } from '../../src/pi/botConfig.ts';
import { createBotSkillsService } from '../../src/pi/botSkills.ts';
import { defaultDataDir } from '../../src/pi/conversationStore.ts';
import { createPiRuntimeController } from '../../src/pi/piRuntimeController.ts';
import { piRuntimeConfigurationForProvider } from '../../src/pi/piProviderSync.ts';
import { resolveWorkspaceLayout, ensureWorkspaceLayout } from '../../src/pi/workspaceLayout.ts';
import { artifactVersionsResponse } from '../../src/pi/artifactCatalog.ts';
import { identityEventForReplay } from '../../src/runtime/replayIdentity.ts';
import { project } from '../../src/exported-project.ts';

const output = resolve('output/first-batch-optimizations-2026-11-01');
const testRoot = mkdtempSync(join(tmpdir(), 'rtb-first-batch-model-'));
const providers = new ProviderStore(join(defaultDataDir() + '.provider-secrets', 'providers.enc'));
const connections = (providers.view().providers ?? project.providers).connections.filter(p => p.enabled);
assert.equal(connections.length, 1, 'Do not choose a different model when the current selection is ambiguous.');
const configuration = piRuntimeConfigurationForProvider(connections[0]);
const selectedGroup = process.env.RTB_SMOKE_GROUP;
const results = selectedGroup ? JSON.parse(readFileSync(join(output, 'model-smoke.json'), 'utf8')).results.filter(row => row.label !== selectedGroup) : [];
for (const assigned of [false, true].filter(assigned => !selectedGroup || selectedGroup === (assigned ? 'skill' : 'baseline'))) {
  const label = assigned ? 'skill' : 'baseline';
  const root = join(testRoot, label), dataDir = join(root, 'data');
  const layout = resolveWorkspaceLayout({ fallbackCwd: join(root, 'workspace') });
  ensureWorkspaceLayout(layout);
  const bots = new BotConfigStore(join(dataDir, 'bots.json'));
  const skills = createBotSkillsService({ dataDir });
  if (assigned) {
    for (const file of ['source-backed-research-report.md', 'incremental-report-update.md']) {
      const text = readFileSync(join('docs/task-skills', file), 'utf8');
      const field = name => text.split('## ' + name + '\n\n')[1].split('\n## ')[0].trim();
      skills.save({ name: field('name'), description: field('description'), instructions: field('instructions') }, skills.state().revision);
    }
    bots.save({ ...bots.require('assistant'), skillIds: skills.state().skills.map(s => s.id) }, bots.view().revision);
  }
  const controller = createPiRuntimeController({ cwd: layout.agents.assistant, layout, appRoot: process.cwd(), dataDir, providers, bots, skills,
    limits: { durationMs: 180_000, outputBytes: 2_000_000, modelRequests: 16 } });
  const conversationId = 'research_acceptance';
  const path = join(layout.agents.assistant, 'report.md');
  const prompts = [
    '请研究 https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md ，仅根据读到的原文用中文约150字说明定位和运行方式，注明来源与提交号，明确这是README声明而非运行验证。将报告写到 report.md，包含用户备注 USER_KEEP。最终调用 publish_artifact({path:"report.md",preserveVersion:true}) 交付。使用当前可用的相关Skill。只允许 web_fetch/read/write/edit/read_skill/publish_artifact 工具；不要执行shell、修改其他文件或对外发送消息。',
    '请增量更新现有 report.md：读取 https://raw.githubusercontent.com/milind-soni/OpenMausBot/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md ，补充约150字比较两项目定位，附新的来源与提交号；保留原有有效内容及用户备注 USER_KEEP。使用当前可用的相关Skill。最后调用 publish_artifact({path:"report.md",preserveVersion:true}) 保留新交付。只允许 web_fetch/read/write/edit/read_skill/publish_artifact；不要shell、删除文件或对外发送。',
  ];
  const deliveries = [];
  try {
    for (let turn = 0; turn < prompts.length; turn++) {
      const events = [];
      const toolNames = [];
      const namesById = new Map();
      await controller.runPrompt({ ...configuration, conversationId, botId: 'assistant', agentPreset: 'assistant', permissionMode: 'request',
        requestId: `${label}-${turn + 1}`, prompt: prompts[turn] }, event => {
        events.push(event);
        if (event.type === 'tool.call.started') { toolNames.push(event.payload.name); namesById.set(event.payload.toolCallId, event.payload.name); }
        if (event.type === 'tool.call.awaiting_approval') {
          const args = event.payload.argsPreview ?? {};
          const tool = String(namesById.get(event.payload.toolCallId) ?? '').toLowerCase();
          const target = typeof args.path === 'string' ? resolve(layout.agents.assistant, args.path) : '';
          const allowed = ['write', 'edit'].includes(tool) && target === path;
          setImmediate(() => controller.resolveApproval(event.payload.toolCallId, allowed ? 'yes' : 'no', conversationId, event.runId));
        }
        if (event.type === 'run.awaiting_input') setImmediate(() => void controller.abort(conversationId));
      }, { signal: AbortSignal.timeout(240_000) });
      const final = events.filter(e => e.type === 'run.finished').at(-1)?.payload;
      const artifacts = events.filter(e => e.type === 'artifact.finished' && String(e.payload.artifactId).startsWith('published_version_'));
      const summary = { label, turn: turn + 1, final, toolNames, deliveries: artifacts.length };
      if (artifacts.length) {
        const artifactId = identityEventForReplay(artifacts.at(-1)).payload.artifactId;
        const response = await artifactVersionsResponse({ store: { get: id => controller.getConversation(id) }, versions: controller.artifactVersions,
          layout, excluded: [dataDir, controller.artifactVersions.root], conversationId, artifactId });
        const version = response.versions.find(v => v.versionId === response.selectedVersionId);
        const file = await controller.artifactVersions.open({ conversationId, artifactId: version.artifactId, versionId: version.versionId });
        const body = await file.file.readFile('utf8'); await file.file.close();
        assert.match(body, /USER_KEEP/);
        mkdirSync(join(output, 'model-reports'), { recursive: true });
        writeFileSync(join(output, 'model-reports', `${label}-${turn + 1}.md`), body);
        deliveries.push({ ...version, body });
      }
      results.push(summary);
      writeFileSync(join(output, 'model-smoke.json'), JSON.stringify({ model: configuration.model, provider: configuration.provider, testRoot, results }, null, 2));
      console.log(JSON.stringify(summary));
    }
    if (deliveries.length === 2) {
      assert.notEqual(deliveries[0].sha256, deliveries[1].sha256);
      const first = deliveries[0];
      const saved = await controller.artifactVersions.open({ conversationId, artifactId: first.artifactId, versionId: first.versionId });
      assert.equal(await saved.file.readFile('utf8'), first.body); await saved.file.close();
    }
  } finally { controller.dispose(); }
}
