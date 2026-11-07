import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
import {piRuntimePlugin} from '../../src/pi/piVitePlugin.ts';
import {createPiHttpHost} from '../../src/pi/piHost.ts';
import {findHeadlessShell} from '../../src/pi/browser/browserService.ts';
import {sandboxLibsPlugin} from '../../scripts/sandbox-libs-plugin.mjs';
const output='output/provider-mascots-2026-11-07';
const dir=mkdtempSync(join(tmpdir(),'rtb-provider-review-'));
const host=createPiHttpHost({cwd:dir,appRoot:process.cwd(),dataDir:join(dir,'data'),browser:false,routineClock:false});
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:5188,strictPort:true},resolve:{dedupe:['react','react-dom']},plugins:[react(),piRuntimePlugin({cwd:dir,createHost:()=>host}),sandboxLibsPlugin()]});
const browser=await chromium.launch({executablePath:findHeadlessShell(),headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
try{
 await server.listen();
 const base=server.resolvedUrls.local[0];
 await page.goto(`${base}#control-plane=${host.controlPlaneAuth.issueEntry(base.replace(/\/$/,''))}`);
 await page.locator('.shell-agent').first().waitFor();
 await page.locator('.shell-agent').first().click({button:'right'});
 const dialog=page.getByRole('dialog');await dialog.waitFor();
 await dialog.getByText('头像与外观',{exact:true}).click();
 await dialog.getByRole('button',{name:'DeepSeek',exact:true}).click();
 await dialog.getByRole('combobox',{name:'预览动作'}).selectOption('thinking');
 await page.waitForFunction(()=>document.querySelector('.bot-creator-preview .raytone-avatar')?.dataset.state==='thinking');
 await page.screenshot({path:`${output}/editor-desktop.png`});
 await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 await page.reload();
 await page.locator('.shell-agent').first().locator('svg[data-mascot="deepseek"]').waitFor();
 await page.locator('.composer-greeting-avatar svg[data-mascot="deepseek"]').waitFor();
 await page.locator('.shell-agent').first().click({button:'right'});
 await dialog.getByText('头像与外观',{exact:true}).click();
 assert.equal(await dialog.getByRole('button',{name:'DeepSeek',exact:true}).getAttribute('aria-pressed'),'true');
 await page.setViewportSize({width:390,height:844});
 await dialog.locator('.bot-character-options').scrollIntoViewIfNeeded();
 await page.screenshot({path:`${output}/editor-mobile.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await dialog.getByRole('button',{name:'自定义 Bot',exact:true}).click();
 assert.equal(await dialog.locator('[data-part=hair] button').nth(5).getAttribute('aria-pressed'),'true');
 await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  await page.goto(`${base}?devtools=1`);
  const picker=page.getByLabel('选择事件流');await picker.click();
  const names=await page.getByRole('menuitemradio').allTextContents();
  assert.ok(names.length>=20);
  for(const name of names){
   if(await picker.getAttribute('aria-expanded')!=='true')await picker.click();
   await page.getByRole('menuitemradio',{name,exact:true}).click();
   await page.waitForTimeout(180);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   assert.equal(overflow,false,`${width} ${name}`);
   results.push({width,name,overflow});
  }
 }
 assert.deepEqual(errors,[]);
 writeFileSync(`${output}/ui-checks.json`,JSON.stringify({savedAndReloaded:true,customPartsRestored:true,fixtures:results,errors},null,2));
 console.log(JSON.stringify({savedAndReloaded:true,customPartsRestored:true,scenarios:results.length,errors}));
}catch(e){await page.screenshot({path:`${output}/check-failure.png`}).catch(()=>{});throw e;}
finally{await browser.close();await server.close();rmSync(dir,{recursive:true,force:true});}
