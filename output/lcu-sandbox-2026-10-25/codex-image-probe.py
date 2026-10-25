"""Real Codex+LCU+Chromium, scripted loopback model endpoint; no external inference.

The SSE fixture follows amontlabs/lcu tests/result_codex_cli.py (MIT).
Only request metadata and image hashes are persisted, never image base64 or prompts.
"""
import base64,hashlib,json,os,pathlib,subprocess,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

root=pathlib.Path('/home/user/lcu-trial');observed=[];failures=[]
scripts=[
    'let tab = await cua.createBrowserTab("chrome", "about:blank", {sessionName:"LCU image check"});',
    'await tab.getScreenshot();',
]
namespace=None;tool_name=None
def blocks(value):
    if isinstance(value,dict):
        yield value
        for v in value.values():yield from blocks(v)
    elif isinstance(value,list):
        for v in value:yield from blocks(v)
def event_payload(item,index):
    response={'id':f'trial-response-{index}','object':'response','model':'fixture','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
    events=[{'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
            {'type':'response.output_item.done','output_index':0,'item':item},
            {'type':'response.completed','response':response}]
    return ''.join('event: '+v['type']+'\ndata: '+json.dumps(v)+'\n\n' for v in events).encode()
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global namespace,tool_name
        try:
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if namespace is None:
                for tool in body.get('tools',[]):
                    if tool.get('name')=='mcp__lcu':
                        namespace=tool['name'];tool_name='js';break
                    if tool.get('name')=='mcp__lcu__js':
                        namespace='';tool_name=tool['name'];break
                if tool_name is None:raise AssertionError('LCU js was not offered to the model endpoint')
            images=[]
            for value in blocks(body.get('input',[])):
                if value.get('type')=='input_image':
                    url=value.get('image_url','')
                    if isinstance(url,str) and url.startswith('data:'):
                        payload=base64.b64decode(url.split(',',1)[1])
                        images.append({'mimeType':url[5:].split(';',1)[0],'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()})
            outputs=[{'callId':v.get('call_id'),'types':[b.get('type') for b in v.get('output',[]) if isinstance(b,dict)] if isinstance(v.get('output'),list) else ['text']} for v in body.get('input',[]) if isinstance(v,dict) and v.get('type')=='function_call_output']
            index=len(observed)
            observed.append({'request':index+1,'images':images,'toolOutputs':outputs})
            if index<len(scripts):
                item={'id':f'trial-tool-{index}','type':'function_call','call_id':f'trial-call-{index}','name':tool_name,'arguments':json.dumps({'code':scripts[index],'title':'Inspect empty test browser'})}
                if namespace:item['namespace']=namespace
            else:
                item={'id':'trial-done','type':'message','status':'completed','role':'assistant','content':[{'type':'output_text','text':'Protocol fixture complete.','annotations':[]}]}
            payload=event_payload(item,index)
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        except Exception as error:
            failures.append(type(error).__name__+': '+str(error));self.send_error(500,'Local fixture error')
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
overrides={
    'model_provider':'lcu_trial','model':'fixture',
    'model_providers.lcu_trial.name':'Isolated protocol fixture',
    'model_providers.lcu_trial.base_url':f'http://127.0.0.1:{server.server_port}/v1',
    'model_providers.lcu_trial.wire_api':'responses',
    'model_providers.lcu_trial.requires_openai_auth':False,
    'mcp_servers.lcu.tools.js.approval_mode':'approve',
}
command=['codex','--strict-config','-a','on-request']
for key,value in overrides.items():command+=['-c',key+'='+json.dumps(value)]
command+=['exec','--ephemeral','--skip-git-repo-check','--json','-C',str(root),'Use LCU to open an empty about:blank test tab and return its screenshot. This is an isolated protocol test.']
report={}
try:
    result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=60,env={**os.environ,'LCU_NO_UPDATE_CHECK':'1','NO_COLOR':'1'})
    events=[]
    for line in result.stdout.splitlines():
        try:events.append(json.loads(line))
        except ValueError:pass
    mcp=[e.get('item',{}) for e in events if e.get('type')=='item.completed' and e.get('item',{}).get('type')=='mcp_tool_call']
    image_results=[]
    for item in mcp:
        for block in blocks(item.get('result',{})):
            if block.get('type')=='image' and block.get('data'):
                data=base64.b64decode(block['data']);image_results.append({'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    received=[im for request in observed for im in request['images']]
    report={'codexExit':result.returncode,'providerRequests':observed,'providerImages':received,'toolImages':image_results,
            'toolStatuses':[{'tool':i.get('tool'),'status':i.get('status'),'error':i.get('error')} for i in mcp],
            'imagesMatch':bool(received and image_results) and received[-1]['sha256']==image_results[-1]['sha256'],
            'failures':failures,'stderrTail':result.stderr[-4000:]}
except subprocess.TimeoutExpired as error:
    def decoded(value):return value.decode(errors='replace') if isinstance(value,bytes) else value or ''
    partial_events=[]
    for line in decoded(error.stdout).splitlines():
        try:
            value=json.loads(line)
            partial_events.append({'type':value.get('type'),'message':value.get('message'),'itemType':value.get('item',{}).get('type'),'itemStatus':value.get('item',{}).get('status')})
        except ValueError:pass
    report={'exception':'TimeoutExpired after 60 seconds','providerRequests':observed,'failures':failures,'stderrTail':decoded(error.stderr)[-6000:],'partialEvents':partial_events}
except Exception as error:report={'exception':type(error).__name__+': '+str(error),'providerRequests':observed,'failures':failures}
finally:server.shutdown()
(root/'codex-image-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,ensure_ascii=False))
raise SystemExit(0 if report.get('imagesMatch') and report.get('codexExit')==0 else 1)
