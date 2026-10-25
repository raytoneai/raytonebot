import json,pathlib,subprocess
root=pathlib.Path('/home/user/lcu-trial')
usage=subprocess.run(['du','-sm',str(root/'app-root'),str(root/'installed'),str(root/'pw-browsers'),str(root/'extension')],capture_output=True,text=True)
processes=subprocess.run(['ps','-eo','pid=,comm=,stat='],capture_output=True,text=True).stdout.splitlines()
names=('chrome','chromium','Xvfb','openbox','cua','bwrap','lcu')
active=[];zombies=[]
for line in processes:
    fields=line.split()
    if len(fields)>2 and any(name.lower() in fields[1].lower() for name in names):
        (zombies if fields[2].startswith('Z') else active).append({'pid':int(fields[0]),'command':fields[1],'state':fields[2]})
print(json.dumps({'sizeMiB':usage.stdout.strip().splitlines(),'remainingActiveProcesses':active,'zombieCount':len(zombies)},indent=2))
