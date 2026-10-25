import json,os,pathlib,signal,time
pid=4928
expected='Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten tcp -auth /tmp/xvfb-run.AJFNV6/Xauthority'
proc=pathlib.Path(f'/proc/{pid}')
if proc.exists():
    actual=proc.joinpath('cmdline').read_bytes().replace(b'\0',b' ').decode().strip()
    if actual!=expected:raise SystemExit('Process identity changed; not terminating')
    os.kill(pid,signal.SIGTERM)
    for _ in range(40):
        if not proc.exists():break
        time.sleep(.1)
print(json.dumps({'terminatedTrialXvfb':not proc.exists()}))
if proc.exists():raise SystemExit(1)
