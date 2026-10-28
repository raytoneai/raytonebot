import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:5188/');
 const second=await context.newPage();await second.goto('http://127.0.0.1:5188/');
 for(const [name,preset,engine] of [['Atlas','planner','Claude Code'],['Bolt','builder','Codex CLI']]){
   await page.getByRole('button',{name:'创建 Bot',exact:true}).click();
   const dialog=page.getByRole('dialog');await dialog.getByLabel('名字',{exact:true}).fill(name);await dialog.locator('select').selectOption(preset);
   await dialog.getByRole('button',{name:'创建 Bot',exact:true}).click();
   const row=page.locator('.shell-agent-row').filter({has:page.locator('.shell-agent-name',{hasText:name})});
   assert.match(await row.innerText(),new RegExp(engine));
   assert.equal(await page.locator('.shell-header-name').innerText(),name);
   await second.locator('.shell-agent-name',{hasText:name}).waitFor();
 }
 await page.locator('.shell-agent-row').filter({has:page.locator('.shell-agent-name',{hasText:'Raer'})}).locator('.raytone-avatar').click({button:'right'});
 await page.getByRole('dialog').getByLabel('名字',{exact:true}).fill('小蕾');
 await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();
 await second.locator('.shell-agent-name',{hasText:'小蕾'}).waitFor();
 await page.locator('.shell-agent').filter({has:page.locator('.shell-agent-name',{hasText:'Group',exact:true})}).click();
 await page.locator('textarea').fill('@');
 await page.locator('.composer-mention').filter({hasText:'小蕾'}).click();
 assert.equal(await page.locator('textarea').inputValue(),'@Raer ');
 await page.getByRole('button',{name:'创建 Bot',exact:true}).click();
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='创建 Bot',undefined,{timeout:2000});
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'创建 Bot');
 assert.deepEqual(errors,[]);
 const checks=['Create Claude Code and Codex Bots with correct engine and header','Profiles synchronize to a second tab','Renamed group member uses canonical @Raer route','Escape returns focus to Logo'];
 await writeFile('output/bot-editor/edge-checks.json',JSON.stringify({checks,errors},null,2));console.log({checks,errors});
}finally{await browser.close();}
