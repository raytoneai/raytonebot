import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {findHeadlessShell} from '../../src/pi/browser/browserService.ts';
import {mkdirSync,rmSync,writeFileSync,copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const dir='output/provider-mascots-2026-11-07';mkdirSync(`${dir}/frames`,{recursive:true});
const browser=await chromium.launch({executablePath:findHeadlessShell(),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:1100},reducedMotion:'reduce'});
 await page.goto(`file://${process.cwd()}/${dir}/preview.html`);
 assert.equal(await page.locator('article').count(),6);
 await page.screenshot({path:`${dir}/lineup.png`,fullPage:true});
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:960,height:850});
 await page.addStyleTag({content:'main{padding:24px 30px}header{margin-bottom:18px}h1{font-size:26px}nav{margin:14px 0}.portrait{height:122px}.portrait>.raytone-avatar{width:122px;height:122px}article{padding:14px 10px}.sizes{margin-top:4px}footer{margin-top:12px}'});
 const bounds=[];
 for(const state of ['idle','listening','thinking','writing','working','reading','editing','asking','success','error','fault','sleep']){
  await page.evaluate(state=>document.querySelectorAll('.portrait>.raytone-avatar').forEach(el=>el.dataset.state=state),state);
  for(const time of [500,1200,2100,3000]){
   await page.evaluate(time=>{for(const a of document.getAnimations()){a.pause();a.currentTime=time;}},time);
   const clipped=await page.evaluate(()=>[...document.querySelectorAll('.portrait svg')].flatMap(svg=>{
    const frame=svg.getBoundingClientRect();
    return [...svg.querySelectorAll('path,rect,circle')].flatMap(el=>{if(el.closest('defs'))return [];const b=el.getBoundingClientRect();return b.left<frame.left-.5||b.top<frame.top-.5||b.right>frame.right+.5||b.bottom>frame.bottom+.5?[svg.dataset.mascot]:[];});
   }));
   assert.deepEqual(clipped,[],`${state} at ${time}ms must remain within SVG viewport`);
   bounds.push({state,time,clipped});
  }
 }
 writeFileSync(`${dir}/motion-bounds.json`,JSON.stringify(bounds,null,2));
 let index=0;
 for(const state of ['idle','thinking','writing','working']){
  await page.locator(`nav button[data-state="${state}"]`).click();
  for(let frame=0;frame<24;frame++){
   await page.evaluate(time=>{for(const a of document.getAnimations()){a.pause();a.currentTime=time;}},frame*120+500);
   await page.screenshot({path:`${dir}/frames/${String(index++).padStart(3,'0')}.png`});
  }
 }
 assert.equal(index,96);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.addStyleTag({content:'body,article{background:#1b202a;color:#e5e8ee}.grid{background:#393f4a;border-color:#393f4a}header p,article p{color:#adb4c0}button{border-color:#515866}button[aria-pressed=true]{background:#e5e8ee;color:#1b202a}'});
 await page.screenshot({path:`${dir}/lineup-dark.png`,fullPage:true});
}finally{await browser.close();}
execFileSync('ffmpeg',['-loglevel','error','-y','-framerate','8','-i',`${dir}/frames/%03d.png`,'-filter_complex','[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer','-loop','0',`${dir}/motion.gif`]);
copyFileSync(`${dir}/frames/040.png`,`${dir}/thinking-frame.png`);
rmSync(`${dir}/frames`,{recursive:true,force:true});
console.log('Checked six avatars across 48 state/time combinations; rendered animation.');
