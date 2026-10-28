import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from '../../src/pi/conversationStore.ts';
import { createPiEventAdapter } from '../../src/harness/adapters/piAdapter.ts';
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from '../../src/pi/workspaceLayout.ts';
const root=mkdtempSync(join(tmpdir(),'raytone-rakazo-ux-'));
const dataDir=join(root,'data'), workRoot=join(root,'workspace');
mkdirSync(dataDir);
const layout=resolveWorkspaceLayout({fallbackCwd:workRoot,root:workRoot}); ensureWorkspaceLayout(layout);
const store=createConversationStore(dataDir), now=Date.now();
function conversation(id,title,body,file,age){
 const runId=`run-${id}`, adapter=createPiEventAdapter({runId});
 store.begin(id,'assistant',title);
 adapter.apply({type:'message_start',message:{role:'assistant'}});
 adapter.apply({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:body}});
 if(file){const path=join(layout.agents.assistant,file);writeFileSync(path,`# ${title}\n\n${body}\n`);adapter.apply({type:'artifact_published',artifactId:'report',title:path,uri:`file://${path}`});}
 adapter.apply({type:'message_end',message:{role:'assistant',stopReason:'stop'}});
 for(const event of adapter.events)store.append(id,{...event,ts:now-age});store.flush(id);
 return {occurrenceId:id,runId,textId:adapter.events.find(e=>e.type==='text.started')?.payload.textId,at:now-age,finishedAt:now-age+1000,status:'success'};
}
const latest=conversation('research-report','竞品研究周报','本周建议：简化 Bot 创建，支持任务编辑，并保留右侧执行控制台。','research-report.md',3600000);
const earlier=conversation('design-notes','设计改进记录','界面评审记录：清晰的任务状态、产物来源与上下文入口。','design-notes.md',86400000);
conversation('empty-chat','整理下一步','这是没有产物的对话。',undefined,1000);
writeFileSync(join(dataDir,'routines.json'),JSON.stringify({routines:[{id:'research-weekly',botId:'assistant',title:'每周竞品研究',instructions:'检查 Rakazo 的公开更新，整理功能与 UI/UX 上可学习的变化，附来源。',schedule:'0 9 * * 1',timezone:'Asia/Shanghai',enabled:false,createdAt:now-86400000,revision:0,conversationId:'research-report',failures:0,lastRun:latest,history:[latest,{...earlier,status:'error',error:'测试数据：来源暂时不可用'}]},{id:'build-weekly',botId:'builder',title:'工程更新检查',instructions:'检查工程更新。',schedule:'0 10 * * 1-5',timezone:'Asia/Shanghai',enabled:false,createdAt:now,revision:0,conversationId:'design-notes',failures:0}]}));
writeFileSync('output/rakazo-ux-2026-10-27/test-env.json',JSON.stringify({root,dataDir,workRoot},null,2));console.log({root,dataDir,workRoot});
