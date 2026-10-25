import json,pathlib,os
found=[]
for proc in pathlib.Path('/proc').iterdir():
    if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
    try:
        args=proc.joinpath('cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
        if int(proc.name)==4928 or '/home/user/lcu-trial/' in args:
            found.append({'pid':int(proc.name),'args':args})
    except (OSError,PermissionError):pass
print(json.dumps(found,indent=2))
