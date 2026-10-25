set -u
trial_dir=/home/user/lcu-trial
LCU_NO_UPDATE_CHECK=1 "$trial_dir/installed/current/bin/lcu" doctor
printf 'doctor_exit=%s\n' "$?"
python3 - <<'PY'
from pathlib import Path
root=Path('/home/user/lcu-trial/lcu-0.13.0-linux-x64')
for p in root.joinpath('scripts').glob('*.mjs'):
 s=p.read_text()
 lines=s.splitlines()
 hits=[i for i,l in enumerate(lines) if any(v in l for v in ['apt-get','libatspi','libx11','dbus-x11','bubblewrap'])]
 for i in hits[:15]:
  print(str(p.relative_to(root))+':'+str(i+1))
  print('\n'.join(lines[max(0,i-2):min(len(lines),i+5)]))
app=Path('/home/user/lcu-trial/app-root/usr/lib/chatgpt/resources')
print('runtime_directories', [str(p.relative_to(app)) for p in app.glob('*') if 'cua' in p.name])
PY
