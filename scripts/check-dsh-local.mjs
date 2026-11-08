// Runs pinned DSH against a local Messages endpoint; --openai / --anthropic check its generic adapter.
// No provider key or real model is used; files and DSH state stay in a temporary directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { runDsh, dshInstallation, isolatedDshHome } from "../src/pi/dshHarness.ts";
import { createModelGateway } from "../src/pi/runtime/modelGateway.ts";

const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-check-"));
const isolated = process.env.RAYTONEBOT_SANDBOX === "1";
let openai = process.argv.includes('--openai');
let api = openai ? 'openai-completions' : process.argv.includes('--anthropic') ? 'anthropic-messages' : undefined;
let model = api ? 'configured-test-model' : 'deepseek-flash';
if (isolated) chmodSync(dir, 0o2770);
const home = join(dir, dir.split("/").at(-1));
const events = [], requests = [];
let step = 0, sessionId, gateway, lease, afterCall;
let nextCall = { type: 'tool_use', id: 'write-test', name: 'write', input: { file_path: join(dir, 'approved.txt'), content: 'approved exactly once' } };
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  assert.equal(req.headers[openai ? 'authorization' : 'x-api-key'], openai ? 'Bearer test-lease' : 'test-lease');
  assert.equal(body.model, model);
  assert.equal(body.dsh_session_log, undefined);
  const call = nextCall; nextCall = afterCall; afterCall = undefined; step++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (openai) {
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chat-${step}`, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', ...(call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: 'Completed local DSH check.' }) });
    send({}, call ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n'); return;
  }
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
  if (isolated) {
    gateway = await createModelGateway({ port: Number(process.env.RAYTONEBOT_GATEWAY_PORT ?? 5190),
      fetcher: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, init) });
    lease = gateway.issue({ baseUrl: "https://example.com", apiKey: "test-lease", model, protocol: openai ? "openai" : "anthropic" });
    assert.notEqual(lease.apiKey, "test-lease");
  }
  const options = {cwd:dir,home,prompt:'Write the approved file, then reply.',systemPrompt:'Use tools when requested.',permissionMode:'request',signal:AbortSignal.timeout(90_000),
    provider:{baseUrl:lease?.baseUrl ?? `http://127.0.0.1:${server.address().port}`,apiKey:lease?.apiKey ?? 'test-lease',model,api},
    emit:event=>events.push(event),onSessionId:id=>{sessionId=id;},
    onPermission:async request=>{request.startExecution();return true;}};
  await runDsh(options);
  assert.ok(sessionId);
  assert.equal(readFileSync(join(dir,'approved.txt'),'utf8'),'approved exactly once');
  assert.ok(events.some(event=>event.type==='tool_execution_end'&&!event.isError));
  await runDsh({...options,resumeId:sessionId,prompt:'Continue the same conversation.',signal:AbortSignal.timeout(90_000)});
  assert.ok(requests.at(-1).messages.some(message=>JSON.stringify(message).includes('approved exactly once')),'native context survives process restart');
  for (const selection of api ? [{ model: 'changed-test-model', api }, ...process.argv.includes('--switch-adapter')
    ? [{ model: 'deepseek-flash', api: undefined }, { model: 'changed-test-model', api }] : []] : []) {
    options.previousModels = [...(options.previousModels ?? []), model];
    ({ model, api } = selection); openai = api === 'openai-completions';
    if (gateway) {
      lease.revoke();
      lease = gateway.issue({ baseUrl: 'https://example.com', apiKey: 'test-lease', model, protocol: openai ? 'openai' : 'anthropic' });
      Object.assign(options.provider, lease);
    }
    options.provider.model = model;
    options.provider.api = api;
    await runDsh({...options,resumeId:sessionId,prompt:'Continue using the newly selected model.',signal:AbortSignal.timeout(90_000)});
    assert.ok(requests.at(-1).messages.some(message=>JSON.stringify(message).includes('approved exactly once')),'changing model retains native context');
  }
  nextCall = {type:'tool_use',id:'read-before-rewrite',name:'read',input:{file_path:join(dir,'approved.txt')}};
  afterCall = {type:'tool_use',id:'rewrite-test',name:'write',input:{file_path:join(dir,'approved.txt'),content:'updated file'}};
  await runDsh({...options,resumeId:sessionId,signal:AbortSignal.timeout(90_000)});
  assert.equal(readFileSync(join(dir,'approved.txt'),'utf8'),'updated file', 'rewritten file remains accessible to host: ' + JSON.stringify(events.slice(-12)));
  nextCall = {type:'tool_use',id:'read-before-edit',name:'read',input:{file_path:join(dir,'approved.txt')}};
  afterCall = {type:'tool_use',id:'edit-test',name:'edit',input:{file_path:join(dir,'approved.txt'),old_string:'updated',new_string:'edited'}};
  await runDsh({...options,resumeId:sessionId,signal:AbortSignal.timeout(90_000)});
  assert.equal(readFileSync(join(dir,'approved.txt'),'utf8'),'edited file', 'edited file remains accessible to host');
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
  lease?.revoke();
  await gateway?.close();
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  if (isolated) execFileSync("/usr/bin/sudo", ["-n", "-u", "raytone-agent", "--", "/usr/bin/rm", "-rf", "--", isolatedDshHome(home, process.env.RAYTONEBOT_AGENT_HOME)]);
  if (process.env.RAYTONE_KEEP_DSH_CHECK) console.log(`Check directory: ${dir}`);
  else rmSync(dir,{recursive:true,force:true});
}
