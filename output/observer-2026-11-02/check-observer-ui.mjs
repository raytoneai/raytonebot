import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';
import {piRuntimePlugin} from '../../src/pi/piVitePlugin.ts';
import {createPiHttpHost} from '../../src/pi/piHost.ts';
import {createManifest} from '../../scripts/observer-manifest.mjs';
import {createRepoSnapshot} from '../../src/pi/observer/version.ts';
import {findHeadlessShell} from '../../src/pi/browser/browserService.ts';
import {controlPlaneCopy} from '../../src/i18n/copy/controlPlane.ts';
import {observerText} from '../../src/i18n/copy/observer.ts';
const output=dirname(new URL(import.meta.url).pathname),root=mkdtempSync(join(tmpdir(),'rtb-observer-ui-'));
process.env.RAYTONEBOT_DATA_DIR=join(root,'data');process.env.RAYTONEBOT_VAULT_DIR=join(root,'vault');process.env.RAYTONEBOT_WORKSPACE_ROOT=join(root,'workspace');process.env.RAYTONEBOT_SANDBOX='0';delete process.env.RAYTONEBOT_PUBLIC_ORIGIN;
const repo=join(root,'repo');mkdirSync(join(repo,'src'),{recursive:true});writeFileSync(join(repo,'src/example.ts'),'// Synthetic fixture, no private data\nexport const observed = true;\n');
const manifestPath=join(repo,'OBSERVER-BUILD.json');writeFileSync(manifestPath,JSON.stringify(createManifest(repo,['src/example.ts'],{buildId:'isolated-ui-fixture'})));
const report={checks:[],errors:[],modelRequests:0,diagnosticRequests:0};let host,vite,browser,entry;
const t=key=>observerText('zh',key);
try{
 host=createPiHttpHost({cwd:root,appRoot:process.cwd(),dataDir:join(root,'data'),vaultDir:join(root,'vault'),browser:false,routineClock:false,sandboxed:false,
  observerRuntime:{repo:()=>createRepoSnapshot({root:repo,manifestPath}),explain:async input=>{input.chargeRequest();input.onUsage({inputTokens:10,outputTokens:5});report.modelRequests++;return {report:'受控统计：没有可验证异常。',proposals:[]}},diagnose:async input=>{
   input.chargeRequest();report.diagnosticRequests++;
   const q=await input.execute({type:'repo_read',path:'src/example.ts',startLine:1,lines:2},input.signal);
   await new Promise(resolve=>setTimeout(resolve,400));input.signal.throwIfAborted();
   return {report:'受控诊断报告：公开源码证据已核对。',proposals:[{kind:'project_suggestion',title:'验证公开源码',inference:'测试样本可增加回归断言；这是推断。',factIds:q.facts.map(f=>f.id),proposedAction:{kind:'add_test',target:{kind:'code',id:'src/example.ts'},description:'为该布尔值增加回归测试。',verificationRefs:q.evidenceRefs.map(e=>e.id)}}]};
  }}});
 await host.controller.configure({providerDefinition:{id:'fixture',name:'Fixture',baseUrl:'https://model.example/v1',protocol:'openai-compatible',authMode:'none',models:['fixture-model']},provider:'fixture',model:'fixture-model'});
 const {default:config}=await import('../../vite.config.ts');
 vite=await createServer({...config,configFile:false,logLevel:'silent',plugins:[...config.plugins.filter(p=>p.name!=='agentcanvas-pi-runtime'),piRuntimePlugin({cwd:root,createHost:()=>host,openEntry:url=>{entry=url}})],server:{...config.server,host:'127.0.0.1',port:0,strictPort:false,hmr:false}});await vite.listen();assert.ok(entry);const origin=new URL(entry).origin;
 browser=await chromium.launch({executablePath:findHeadlessShell(),headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(entry,{waitUntil:'domcontentloaded',timeout:60000});entry=undefined;await page.locator('.shell-footer-button').waitFor({timeout:30000});
 const settings=async()=>{await page.locator('.shell-footer-button:visible').last().click();await page.getByRole('button',{name:'开发者模式',exact:true}).click();await page.locator('[data-observer-settings]').waitFor();};
 await page.locator('.shell-footer-button:visible').last().click();await page.getByRole('button',{name:'开发者模式',exact:true}).click();await page.getByRole('button',{name:controlPlaneCopy.zh.grant,exact:true}).click();await page.locator('[data-observer-settings] select').first().waitFor();
 let section=page.locator('[data-observer-settings]');await section.getByRole('combobox',{name:t('model'),exact:true}).selectOption(JSON.stringify(['fixture','fixture-model']));await section.getByRole('switch',{name:t('enabled'),exact:true}).click();await section.getByRole('button',{name:t('save'),exact:true}).click();await section.getByRole('button',{name:t('chat'),exact:true}).waitFor();

 await section.getByRole('button',{name:t('analyze'),exact:true}).click();await page.waitForTimeout(700);assert.equal(report.modelRequests,1);
 await section.getByRole('button',{name:t('chat'),exact:true}).click();
 const composer=page.locator('textarea').first();await composer.fill('检查公开样本源码并提供证据');await composer.press('Enter');
 await page.getByText('受控诊断报告：公开源码证据已核对。',{exact:false}).first().waitFor({timeout:20000});assert.equal(report.diagnosticRequests,1);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('检查公开样本源码并提供证据'))),false,'Observer question must not enter browser storage');
 await page.screenshot({path:join(output,'observer-chat-desktop.png')});report.checks.push('explicit model/enable; L1 and L2 controlled runners; report in existing chat; no persistent draft');
 await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.locator('.session-bot-toggle').filter({hasText:'Observer'}).click();await page.getByRole('button',{name:'检查公开样本源码并提供证据',exact:false}).first().click();await page.getByText('受控诊断报告：公开源码证据已核对。',{exact:false}).first().waitFor({timeout:20000});assert.equal(report.diagnosticRequests,1,'refresh must not rerun model');assert.equal(await page.getByText('此 Bot 的模型服务不可用，请在设置中启用服务或修改 Bot 模型。',{exact:true}).count(),0,'Observer availability comes from its host model');
 await settings();section=page.locator('[data-observer-settings]');const card=section.locator('[data-observer-finding]').first();await card.waitFor();await card.getByRole('button',{name:t('accept'),exact:true}).click();await page.waitForTimeout(200);await page.screenshot({path:join(output,'observer-review-desktop.png')});
 await section.locator('[data-observer-clear-runs]').click();await page.waitForFunction(()=>document.querySelector('[data-observer-clear-runs]')?.textContent?.includes('(0)'));report.checks.push('explicit cleanup removes L1 no-findings run and preserves reviewed finding');
 const session=await(await context.request.get(`${origin}/__agentcanvas/pi/auth/session`)).json();const view=await(await context.request.get(`${origin}/__agentcanvas/pi/observer`)).json();assert.equal(view.findings[0].reviewStatus,'accepted');assert.equal(view.finishedWithoutFindings,0);const f=view.findings[0];
 await card.getByRole('button',{name:new RegExp('^'+t('evidence')+' ·')}).first().click();await page.locator('[data-ephemeral="true"]').waitFor();const evidence=page.locator('[data-ephemeral="true"]').first();assert.equal(await evidence.locator('a[download],form').count(),0);await page.getByText('Synthetic fixture, no private data',{exact:false}).first().waitFor();await page.screenshot({path:join(output,'observer-evidence-desktop.png')});report.checks.push('refresh restores report without model replay; review revision; read-only ephemeral evidence');
 await settings();section=page.locator('[data-observer-settings]');await section.locator('[data-observer-finding]').first().locator('summary').click();await section.getByRole('textbox',{name:new RegExp(t('handoffScope'))}).fill('仅查看证据并规划测试');await section.getByRole('button',{name:t('handoff'),exact:true}).click();await page.waitForFunction(id=>document.querySelector('textarea')?.value.includes(id),f.id);assert.match(await page.locator('textarea').first().inputValue(),new RegExp(f.id));assert.equal(report.diagnosticRequests,1);report.checks.push('accepted finding creates explicit ordinary-Bot handoff draft; no auto submission');
 await settings();await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'observer-review-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByRole('button',{name:controlPlaneCopy.zh.revoke,exact:true}).click();assert.equal((await context.request.get(`${origin}/__agentcanvas/pi/observer`)).status(),403);await page.waitForFunction(()=>!document.querySelector('[data-observer-finding]'));assert.equal(await page.locator('[data-observer-finding]').count(),0);assert.equal(await page.locator('[data-ephemeral="true"]').count(),0);report.checks.push('390px layout; developer revocation removes private views and rejects direct report access');
 assert.equal(readFileSync(join(root,'data','observer','state.json'),'utf8').includes('Synthetic fixture, no private data'),false,'raw code query bytes must not persist');
}catch(error){if(browser){ const p=browser.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:join(output,'observer-failure.png')});report.failureText=await p.locator('body').innerText();}}report.errors.push((error?.stack??String(error)).replace(/#control-plane=[^\s'"<>]+/g,'#control-plane=<redacted>'));}
finally{await browser?.close();await vite?.close();if(!vite)await host?.dispose();rmSync(root,{recursive:true,force:true});writeFileSync(join(output,'observer-ui-results.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
