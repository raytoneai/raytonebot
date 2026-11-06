import {preview} from 'vite';
import react from '@vitejs/plugin-react';
import {sandboxLibsPlugin} from '../../scripts/sandbox-libs-plugin.mjs';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {piRuntimePlugin} from '../../src/pi/piVitePlugin.ts';
import {createPiHttpHost} from '../../src/pi/piHost.ts';
import {createConversationStore} from '../../src/pi/conversationStore.ts';
import {createPiEventAdapter} from '../../src/harness/adapters/piAdapter.ts';
const dataRoot=mkdtempSync(join(tmpdir(),'rtb-navigation-'));
const dataDir=join(dataRoot,'data'),cwd=join(dataRoot,'workspace');mkdirSync(cwd,{recursive:true});
const store=createConversationStore(dataDir);
for(const [id,preset,title] of [['nav_raer','assistant','创作短篇小说《灯塔》'],['nav_raer_older','assistant','创作科幻短篇小说《潮汐》'],['nav_tonny','planner','部署连接验证'],['nav_bob','builder','电商经营看板'],['group_navigation','assistant','项目讨论']]) {
  store.begin(id,preset,title);
  const adapter=createPiEventAdapter({runId:`test_${id}`});adapter.startUserMessage(title);
  adapter.apply({type:'message_start',message:{role:'assistant'}});
  adapter.apply({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:('这是用于界面验收的模拟历史，没有调用模型。可以在右侧查找历史、管理群成员，或打开工作区文件。\n\n').repeat(id==='nav_raer'?12:2)}});
  adapter.finish('success');for(const e of adapter.events)store.append(id,e);store.flush(id);
}
const groupFile=join(store.dir,'group_navigation.json');const group=store.get('group_navigation');writeFileSync(groupFile,JSON.stringify({...group,group:{lines:[{author:'me',text:'项目讨论'}],members:['assistant','planner','builder'],hostId:'assistant',participants:[{id:'assistant',name:'Raer',presetId:'assistant'},{id:'planner',name:'Tonny',presetId:'planner'},{id:'builder',name:'Bob',presetId:'builder'}]}}));
const host=createPiHttpHost({cwd,dataDir,browser:false});
const server=await preview({configFile:false,root:process.cwd(),cacheDir:join(dataRoot,'cache'),plugins:[react(),sandboxLibsPlugin(),{name:'review-entry',configurePreviewServer(vite){vite.middlewares.use('/navigation-review',(req,res)=>{res.statusCode=302;res.setHeader('location',`/#control-plane=${host.controlPlaneAuth.issueEntry('http://127.0.0.1:5189')}`);res.end();});}},piRuntimePlugin({cwd,createHost:()=>host})],preview:{host:'127.0.0.1',port:5189,strictPort:true},resolve:{dedupe:['react','react-dom']}});

const proof=host.controlPlaneAuth.issueEntry('http://127.0.0.1:5189');
const res=await fetch('http://127.0.0.1:5189/__agentcanvas/pi/auth/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:proof})});const view=await res.json();
const sessionFile=join(dataRoot,'session.json');writeFileSync(sessionFile,JSON.stringify({cookie:res.headers.get('set-cookie').split(';')[0],csrfToken:view.csrfToken}),{mode:0o600});
writeFileSync('output/navigation-2026-11-03/state.json',JSON.stringify({dataRoot,sessionFile}),{mode:0o600});
console.log('Isolated UI review ready at http://127.0.0.1:5189/navigation-review');
