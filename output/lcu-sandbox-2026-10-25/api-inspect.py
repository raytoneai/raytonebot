import json,pathlib,re,subprocess
root=pathlib.Path('/home/user/lcu-trial')
r=json.loads((root/'browser-probe-report.json').read_text())
texts=[]
for name in ['discovery','createTab']:
    for item in r.get(name,{}).get('result',{}).get('content',[]):
        if item.get('type')=='text':texts.append(item['text'])
lines='\n'.join(texts).splitlines()
hits=set()
for i,line in enumerate(lines):
    if re.search(r'(getAXState|getScreenshot|typeText|interface Tab\b|class Tab\b|frameLocator|click\(|typeText\(|screenshot\(|getByRole|interface Playwright)',line):
        hits.update(range(max(0,i-2),min(len(lines),i+4)))
for i in sorted(hits):print(f'{i+1}: {lines[i]}')
auth=subprocess.run(['codex','login','status'],capture_output=True,text=True,timeout=15)
print(json.dumps({'codexLoginStatusExit':auth.returncode,'authenticated':auth.returncode==0}))
