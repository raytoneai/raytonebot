"""LCU Chrome fixture probe, with only the loopback fixture origin approved."""
import base64,json,os,pathlib,re,selectors,subprocess,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs

root=pathlib.Path('/home/user/lcu-trial')
requests_seen=[]; approvals=[]; saved=[]
page='''<!doctype html><meta charset="utf-8"><title>Raytone LCU sandbox trial</title>
<style>body{font:24px sans-serif;padding:40px}input,button{font:inherit;padding:10px}#status{margin:20px 0;color:green}</style>
<h1>LCU isolated browser trial</h1><label for="message">Message</label><input id="message">
<button onclick="fetch('/save?text='+encodeURIComponent(document.querySelector('#message').value)).then(()=>document.querySelector('#status').textContent='Saved')">Save</button><div id="status">Ready</div>
<iframe id="embedded" src="http://127.0.0.1:8766/frame" width="900" height="160"></iframe>'''.encode()
frame_page='''<!doctype html><meta charset="utf-8"><title>Cross-origin frame</title><label for="frameMessage">Frame message</label><input id="frameMessage"><button onclick="fetch('/save?text='+encodeURIComponent(document.querySelector('#frameMessage').value)).then(()=>document.querySelector('#result').textContent='Frame saved')">Save frame</button><div id="result">Frame ready</div>'''.encode()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        requests_seen.append({'path':self.path,'agent':self.headers.get('x-browser-agent')})
        if self.path.startswith('/save?'):
            saved.extend(parse_qs(urlsplit(self.path).query).get('text',[])); data=b'ok'
        elif self.path=='/frame':data=frame_page
        else:data=page
        self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(data)
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',8765),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
frame_server=ThreadingHTTPServer(('127.0.0.1',8766),Handler)
threading.Thread(target=frame_server.serve_forever,daemon=True).start()
log=(root/'browser-probe.stderr').open('w')
env={**os.environ,'LCU_NO_UPDATE_CHECK':'1','NODE_REPL_DISABLE_ANALYTICS':'1'}
proc=subprocess.Popen([str(root/'installed/current/bin/lcu'),'--chrome'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=env)
selector=selectors.DefaultSelector();selector.register(proc.stdout,selectors.EVENT_READ)
buffer=b'';sequence=0
identity={'session_id':'raytone-lcu-isolated-trial','turn_id':'browser-check-1'}
def send(message):
    proc.stdin.write(json.dumps(message).encode()+b'\n');proc.stdin.flush()
def call(method,params,timeout=45):
    global sequence,buffer
    sequence+=1;target=sequence
    send({'jsonrpc':'2.0','id':target,'method':method,'params':params})
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1);message=json.loads(line)
            if message.get('id')==target and 'method' not in message:return message
            if 'id' in message and 'method' in message:
                urls=re.findall(r'https?://[^\s"<>]+',json.dumps(message.get('params',{})))
                allowed=bool(urls) and all(urlsplit(u).scheme=='http' and urlsplit(u).hostname=='127.0.0.1' and urlsplit(u).port in [8765,8766] for u in urls)
                action='accept' if message['method']=='elicitation/create' and allowed else 'decline'
                approvals.append({'method':message['method'],'urls':urls,'action':action})
                send({'jsonrpc':'2.0','id':message['id'],'result':{'action':action,'content':{}}})
        if selector.select(max(0,deadline-time.monotonic())):
            chunk=proc.stdout.read1(65536)
            if not chunk:raise RuntimeError('LCU closed stdout')
            buffer+=chunk
    raise TimeoutError(method)
def js(code):
    return call('tools/call',{'name':'js','arguments':{'code':code,'title':'Check isolated browser fixture'},'_meta':{'x-codex-turn-metadata':identity}})
report={}
try:
    report['initialize']=call('initialize',{'protocolVersion':'2024-11-05','capabilities':{'elicitation':{}},'clientInfo':{'name':'raytone-lcu-trial','version':'1'}})
    send({'jsonrpc':'2.0','method':'notifications/initialized'})
    report['discovery']=js('await cua.getState();')
    report['createTab']=js('let tab = await cua.createBrowserTab("chrome", "http://127.0.0.1:8765/", { sessionName: "LCU trial" });')
    def text_of(response):return '\n'.join(x.get('text','') for x in response.get('result',{}).get('content',[]) if x.get('type')=='text')
    field=re.search(r'(?m)^\s*(\d+) text field .*ID: message$',text_of(report['createTab']))
    if not field:raise AssertionError('Message field absent from actual AX state')
    report['type']=js(f'await tab.typeText({field.group(1)}, "LCU 中文验证 Café 2026"); await tab.getAXState();')
    button=re.search(r'(?m)^\s*(\d+) button Save$',text_of(report['type']))
    if not button:
        report['beforeClick']=js('await tab.getAXState({disableDiffing:true});')
        button=re.search(r'(?m)^\s*(\d+) button Save$',text_of(report['beforeClick']))
    if not button:raise AssertionError('Save button absent from current AX state')
    report['click']=js(f'await tab.click({button.group(1)}); await tab.getAXState();')
    report['frameFill']=js('await tab.playwright.frameLocator("#embedded").getByLabel("Frame message").fill("LCU cross-origin frame", {timeoutMs:5000}); await tab.getAXState();')
    report['frameClick']=js('await tab.playwright.frameLocator("#embedded").getByRole("button", {name:"Save frame",exact:true}).click({timeoutMs:5000}); await tab.getAXState();')
    report['screenshot']=js('await tab.getScreenshot();')
    report['checks']={'unicodeSaved': 'LCU 中文验证 Café 2026' in saved,'crossOriginFrameSaved':'LCU cross-origin frame' in saved,'imageReturned':any(x.get('type')=='image' and len(x.get('data',''))>100 for x in report['screenshot'].get('result',{}).get('content',[]))}
    report['endTurn']=call('tools/call',{'name':'turn_ended','arguments':{**identity,'hook_event_name':'Stop'}})
    report['afterEnd']=js('await tab.getAXState();')
except Exception as error:
    report['exception']={'type':type(error).__name__,'message':str(error)}
finally:
    try:proc.stdin.close();proc.wait(timeout=10)
    except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=10)
    selector.close();log.close();server.shutdown();frame_server.shutdown()
    report.update({'approvals':approvals,'requests':requests_seen,'saved':saved,'processExit':proc.returncode,'stderrTail':(root/'browser-probe.stderr').read_text()[-4000:]})
    (root/'browser-probe-report.json').write_text(json.dumps(report,indent=2))
    for step,value in report.items():
        if isinstance(value,dict) and 'result' in value:
            result=value['result'];content=result.get('content',[])
            summary=[]
            for i,item in enumerate(content):
                if item.get('type')=='image':
                    image_path=root/f'{step}-{i}.png';image_path.write_bytes(base64.b64decode(item['data']))
                    summary.append({'type':'image','mimeType':item.get('mimeType'),'bytes':image_path.stat().st_size,'file':str(image_path)})
                elif item.get('type')=='text':
                    value=item.get('text','');summary.append({'type':'text','text':value if len(value)<1600 else value[:350]+'\n[...abbreviated...]\n'+value[-1250:]})
            print(json.dumps({'step':step,'isError':result.get('isError'),'content':summary},ensure_ascii=False))
        elif step!='initialize':print(json.dumps({step:value},ensure_ascii=False))
