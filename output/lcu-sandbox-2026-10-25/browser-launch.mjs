import { writeFile, readFile } from 'node:fs/promises';
const root='/home/user/lcu-trial';
const {chromium}=await import(`${root}/app-root/usr/lib/chatgpt/resources/cua_node/lib/node_modules/playwright-core/index.mjs`);
const extension=`${root}/extension`;
const context=await chromium.launchPersistentContext('/home/user/.config/chromium',{
  headless:false,chromiumSandbox:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
});
const matches=worker=>worker.url().startsWith('chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/');
const worker=context.serviceWorkers().find(matches)??await context.waitForEvent('serviceworker',{predicate:matches,timeout:45000});
const manifest=JSON.parse(await readFile(`${extension}/manifest.json`,'utf8'));
await writeFile(`${root}/browser-ready.json`,JSON.stringify({browserVersion:context.browser()?.version(),extensionVersion:manifest.version,worker:worker.url(),chromiumSandbox:true}));
let closing=false;
const close=async()=>{if(closing)return;closing=true;await context.close();process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
await new Promise(()=>{});
