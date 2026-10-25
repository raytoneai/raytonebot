"""Isolated LCU JSON-RPC probe; no model key, personal profile, or external page."""
import json, os, pathlib, selectors, subprocess, time

root=pathlib.Path('/home/user/lcu-trial')
log=(root/'mcp-probe.stderr').open('w')
env={**os.environ,'LCU_NO_UPDATE_CHECK':'1','NODE_REPL_DISABLE_ANALYTICS':'1'}
proc=subprocess.Popen([str(root/'installed/current/bin/lcu')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=env)
selector=selectors.DefaultSelector(); selector.register(proc.stdout,selectors.EVENT_READ)
buffer=b''; sequence=0

def send(message):
    proc.stdin.write(json.dumps(message).encode()+b'\n'); proc.stdin.flush()

def call(method,params,timeout=45):
    global sequence,buffer
    sequence+=1; target=sequence
    send({'jsonrpc':'2.0','id':target,'method':method,'params':params})
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            message=json.loads(line)
            if message.get('id')==target and 'method' not in message:
                return message
            if 'id' in message and 'method' in message:
                send({'jsonrpc':'2.0','id':message['id'],'result':{'action':'decline'}})
        if selector.select(max(0,deadline-time.monotonic())):
            chunk=proc.stdout.read1(65536)
            if not chunk: raise RuntimeError('LCU process closed stdout')
            buffer+=chunk
    raise TimeoutError(method)

report={}
try:
    report['initialize']=call('initialize',{'protocolVersion':'2024-11-05','capabilities':{'elicitation':{}},'clientInfo':{'name':'raytone-lcu-trial','version':'1'}})
    send({'jsonrpc':'2.0','method':'notifications/initialized'})
    listing=call('tools/list',{})
    (root/'mcp-tools.json').write_text(json.dumps(listing,indent=2))
    report['tools']=[{'name':t['name'],'inputSchema':t.get('inputSchema')} for t in listing.get('result',{}).get('tools',[])]
    response=call('tools/call',{'name':'js','arguments':{'code':'await cua.getState();','title':'Inspect isolated test desktop'}})
    (root/'mcp-get-state.json').write_text(json.dumps(response,indent=2))
    report['getState']=response
    report['reset']=call('tools/call',{'name':'js_reset','arguments':{}})
except Exception as error:
    report['exception']={'type':type(error).__name__,'message':str(error)}
finally:
    try: proc.stdin.close(); proc.wait(timeout=10)
    except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=10)
    report['processExit']=proc.returncode
    selector.close(); log.close()
    report['stderrTail']=(root/'mcp-probe.stderr').read_text()[-6000:]
    (root/'mcp-probe-report.json').write_text(json.dumps(report,indent=2))
    def concise(value):
        if isinstance(value,list): return [concise(v) for v in value]
        if isinstance(value,dict):
            if value.get('type')=='image': return {k:v for k,v in value.items() if k!='data'} | {'dataLength':len(value.get('data',''))}
            return {k:concise(v) for k,v in value.items()}
        if isinstance(value,str) and len(value)>6000: return value[:1500]+'\n[...abbreviated...]\n'+value[-4500:]
        return value
    report['initialize']={'serverInfo':report.get('initialize',{}).get('result',{}).get('serverInfo')}
    print(json.dumps(concise(report),ensure_ascii=False))
