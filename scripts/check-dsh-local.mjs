// Runs the installed, pinned DSH against a deterministic local Messages endpoint.
// No provider key or real model is used; files and DSH state stay in a temporary directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { runDsh, dshInstallation } from "../src/pi/dshHarness.ts";

const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-check-"));
const events = [], requests = [];
let step = 0, sessionId;
let nextCall = { type: 'tool_use', id: 'write-test', name: 'write', input: { file_path: join(dir, 'approved.txt'), content: 'approved exactly once' } };
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  assert.equal(req.headers['x-api-key'], 'test-lease');
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.dsh_session_log, undefined);
  const call = nextCall; nextCall = undefined; step++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start', { message: { id: `msg-${step}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: {input_tokens:10,output_tokens:0} } });
  send('content_block_start', { index: 0, content_block: call ? {...call,input:{}} : { type:'text',text:'' } });
  send('content_block_delta', { index: 0, delta: call ? {type:'input_json_delta',partial_json:JSON.stringify(call.input)} : {type:'text_delta',text:'Completed local DSH check.'} });
  send('content_block_stop', { index:0 });
  send('message_delta', { delta: {stop_reason:call?'tool_use':'end_turn', stop_sequence:null}, usage:{output_tokens:10} });
  send('message_stop', {}); res.end();
});
try {
  console.log(`DSH installation: ${dshInstallation()}`);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const options = {cwd:dir,home:join(dir,'native'),prompt:'Write the approved file, then reply.',systemPrompt:'Use tools when requested.',permissionMode:'request',signal:AbortSignal.timeout(90_000),
    provider:{baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test-lease',model:'deepseek-flash'},
    emit:event=>events.push(event),onSessionId:id=>{sessionId=id;},
    onPermission:async request=>{request.startExecution();return true;}};
  await runDsh(options);
  assert.ok(sessionId);
  assert.equal(readFileSync(join(dir,'approved.txt'),'utf8'),'approved exactly once');
  assert.ok(events.some(event=>event.type==='tool_execution_end'&&!event.isError));
  await runDsh({...options,resumeId:sessionId,prompt:'Continue the same conversation.',signal:AbortSignal.timeout(90_000)});
  assert.ok(requests.at(-1).messages.some(message=>JSON.stringify(message).includes('approved exactly once')),'native context survives process restart');
  nextCall = {type:'tool_use',id:'denied-write',name:'write',input:{file_path:join(dir,'denied.txt'),content:'must not exist'}};
  await runDsh({...options,resumeId:sessionId,onPermission:async request=>{request.startExecution();return 'Denied for test';},signal:AbortSignal.timeout(90_000)});
  assert.equal(existsSync(join(dir,'denied.txt')),false,'denied native write has no side effect');
  assert.ok(events.some(event=>event.type==='tool_execution_end'&&event.toolCallId==='denied-write'&&event.isError));
  let hostCalls=0;
  nextCall={type:'tool_use',id:'host-call',name:'host_probe',input:{text:'bridge verified'}};
  await runDsh({...options,resumeId:sessionId,signal:AbortSignal.timeout(90_000),hostTools:{
    specs:[{name:'host_probe',description:'Test the host tool bridge.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],
    run:async (_name,args)=>{hostCalls++;return {text:args.text,isError:false};}}});
  assert.equal(hostCalls,1,'host tool executes exactly once');
  assert.ok(requests.at(-1).messages.some(message=>JSON.stringify(message).includes('bridge verified')));
  const beforeMissing=requests.length;
  await assert.rejects(runDsh({...options,resumeId:'b5090f7b-58ad-4003-926a-ff5313202382',signal:AbortSignal.timeout(90_000)}));
  assert.equal(requests.length,beforeMissing,'missing context is never replaced with a new model turn');
  const cancel=new AbortController();
  nextCall={type:'tool_use',id:'long-bash',name:'bash',input:{description:'Wait for cancellation test',command:`sleep 30 & echo $! > '${join(dir,'child.pid')}'; wait`}};
  const running=runDsh({...options,resumeId:sessionId,signal:cancel.signal});
  const deadline=Date.now()+30_000;
  while(!existsSync(join(dir,'child.pid'))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
  if(!existsSync(join(dir,'child.pid'))) {cancel.abort();await running;throw Error('Native bash did not start');}
  const childPid=Number(readFileSync(join(dir,'child.pid'),'utf8').trim());
  cancel.abort(); await running;
  assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'},'stop reaps the native shell descendant');
  console.log(`PASS: real DSH approval/rejection, host tool, missing context, stop/descendant cleanup, and restart/resume (${requests.length} model requests).`);
} finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  if (process.env.RAYTONE_KEEP_DSH_CHECK) console.log(`Check directory: ${dir}`);
  else rmSync(dir,{recursive:true,force:true});
}
