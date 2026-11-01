import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findHeadlessShell } from '../../../src/pi/browser/browserService.ts';
const mode = process.argv[2];
if (!['baseline', 'working'].includes(mode)) throw new Error('Use: node compare-styles.mjs baseline|working');
const source = (path) => mode === 'baseline' ? execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' }) : readFileSync(path, 'utf8');
const css = `${source('src/styles/app.css')}\n${source('src/styles/agentmatrix.css')}`;
const props = ['display','gridTemplateColumns','gap','rowGap','columnGap','flexWrap','alignItems','borderTopWidth','borderTopStyle','borderTopColor','borderRadius','boxShadow','backgroundImage','backgroundColor','padding','color','fontSize','fontFamily','textTransform','marginTop','strokeWidth'];
const selectors = ['.composer-frame','.step-item','.step-item .step-icon','.step-item .step-icon svg','.step-item .step-kind','.step-item[data-status=error] .step-icon','.error-item','.error-item .error-icon','.error-item strong','.error-item p','.error-item small'];
const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
const results=[];
try {
 for (const context of ['bare','preview']) for (const width of [1280,390]) for (const appearance of ['light','dark']) for (const style of ['native','illustrated']) {
  const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
  const wrap=context==='preview'?`<section class="preview-frame" data-appearance="${appearance}" data-style-preset="${style}" style="position:fixed;inset:0;width:100vw;height:100vh;display:block;padding:40px;z-index:99999;--native-muted-text:#60646c;--surface-panel:#fcfcfd">`:'';
  await page.setContent(`<!doctype html><html><head><style>${css}</style><style>.preview-frame[data-appearance="dark"]{--surface-panel:#202126;--text-primary:#f5f5f7;--text-muted:#b7b8c0;--native-muted-text:#b7b8c0}.preview-frame[data-appearance="light"]{--surface-panel:#fcfcfd;--text-primary:#1c2024;--text-muted:#60646c;--native-muted-text:#60646c}</style></head><body style="margin:0"><div id="batch5-cascade-fixture">${wrap}<div style="max-width:720px;padding:40px"><div class="composer-frame"><div class="composer-tools">fixture</div></div><article class="step-item" data-status="completed"><span class="step-icon"><svg viewBox="0 0 10 10"><path d="M1 5l3 3 5-6"/></svg></span><span class="step-kind">tool call</span><strong>Completed</strong><p>Representative lifecycle row</p></article><article class="step-item" data-status="error"><span class="step-icon"><svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg></span><span class="step-kind">tool call</span><strong>Failed</strong><p>Failure row</p></article><article class="error-item" data-collapse="false"><span class="error-icon"><svg viewBox="0 0 10 10"><path d="M5 1v8"/></svg></span><strong>Tool failed</strong><p>Representative error description</p><small>Retry details</small></article></div>${context==='preview'?'</section>':''}</div></body></html>`);
  const computed=await page.evaluate(({selectors,props})=>Object.fromEntries(selectors.map(s=>{const e=document.querySelector('#batch5-cascade-fixture '+s),c=getComputedStyle(e);return[s,Object.fromEntries(props.map(k=>[k,c[k]]))]})),{selectors,props});
  const id=`${context}-${width}-${appearance}-${style}`;await page.screenshot({path:`output/review-fixes-2026-11-01/batch5-styles/${mode}-${id}.png`});results.push({id,context,width,appearance,style,computed});await page.close();
 }
} finally { await browser.close(); }
writeFileSync(`output/review-fixes-2026-11-01/batch5-styles/${mode}-complete-css.json`,JSON.stringify(results,null,2));
