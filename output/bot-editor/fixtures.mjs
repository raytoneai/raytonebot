import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:5188/?devtools=1');
 const picker=page.getByLabel('选择事件流');await picker.click();
 const menuItems=page.getByRole('menuitemradio');
 const names=await menuItems.allTextContents();
 console.log('fixtures',names.length);
 const results=[];
 for(const name of names){
   if(!(await picker.getAttribute('aria-expanded')==='true'))await picker.click();
   await page.getByRole('menuitemradio',{name,exact:true}).click();
   await page.waitForTimeout(350);
   assert.equal(await page.getByRole('button',{name:'创建 Bot',exact:true}).count(),name==='欢迎页(无事件)'?1:0);
   results.push({name,chat:await page.locator('.chat-frame').count(),tools:await page.locator('.tool-call-card').count(),bodyLength:(await page.locator('.preview-frame').innerText()).length,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
   if(['Group chat','Tool approval','Error block','HTML artifact stream','Terminal incident'].includes(name))await page.screenshot({path:`output/bot-editor/fixture-${name.replaceAll(' ','-')}.png`});
 }
 assert.equal(names.length,20);
 assert.deepEqual(errors,[]);
 await picker.click();await page.getByRole('menuitemradio',{name:'欢迎页(无事件)',exact:true}).click();
 await page.evaluate(()=>localStorage.setItem('raytonebot.theme','slate-blue'));
 await page.reload();
 await page.getByRole('button',{name:'创建 Bot',exact:true}).click();
 await page.getByRole('dialog').getByLabel('名字',{exact:true}).fill('Nova');
 await page.screenshot({path:'output/bot-editor/create-dark.png'});
 await writeFile('output/bot-editor/fixtures.json',JSON.stringify({results,errors},null,2));
 console.log(JSON.stringify({scenarios:results.length,errors,overflow:results.filter(r=>r.overflow)},null,2));
}finally{await browser.close();}
