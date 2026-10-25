import json, os, pathlib, platform, shutil, subprocess

def run(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return {'exit':result.returncode,'stdout':result.stdout.strip()[:2000],'stderr':result.stderr.strip()[:500]}
    except Exception as error:
        return {'error':type(error).__name__}

commands = ['codex','node','Xvfb','dbus-run-session','google-chrome','chromium','bwrap','sudo']
paths = ['/usr/lib/chatgpt','/opt/ChatGPT','/opt/chatgpt','/opt/lcu','/opt/pw-browsers']
result = {
    'osRelease':pathlib.Path('/etc/os-release').read_text(),
    'arch':platform.machine(),'glibc':platform.libc_ver(),'uid':os.getuid(),
    'commands':{key:shutil.which(key) for key in commands},
    'appPaths':{key:pathlib.Path(key).exists() for key in paths},
    'codex':run(['codex','--version']),'node':run(['node','--version']),
    'displayPresent':bool(os.environ.get('DISPLAY')),
    'dbusSessionPresent':bool(os.environ.get('DBUS_SESSION_BUS_ADDRESS')),
    'sudo':run(['sudo','-n','true']),
    'disk':run(['df','-h','/']),
}
print(json.dumps(result,indent=2))
