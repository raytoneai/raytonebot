set -eu
trial_dir=/home/user/lcu-trial
sudo apt-get update -qq > "$trial_dir/apt-update.log" 2>&1
if ! sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  xvfb xauth openbox at-spi2-core bubblewrap dbus-x11 libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
  libgdk-pixbuf-2.0-0 libgl1 libglib2.0-bin libglib2.0-0 libgtk-3-0 libnotify4 \
  libnspr4 libnss3 libpango-1.0-0 libssl3 libtss2-esys-3.0.2-0 libtss2-mu0 \
  libtss2-tcti-device0 libusb-1.0-0 libx11-xcb1 libxcb-dri3-0 libxcomposite1 \
  libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxtst6 x11-utils xdg-utils \
  > "$trial_dir/apt-desktop.log" 2>&1; then
  tail -n 50 "$trial_dir/apt-desktop.log"
  exit 1
fi
tail -n 6 "$trial_dir/apt-desktop.log"
python3 - <<'PY'
from pathlib import Path
import subprocess,json
root=Path('/home/user/lcu-trial/app-root/usr/lib/chatgpt/resources')
bad=[]; checked=0
for p in root.rglob('*.node'):
 if any(s in str(p).lower() for s in ['sky','cua','computer-use']):
  checked+=1
  r=subprocess.run(['ldd',str(p)],capture_output=True,text=True)
  missing=[s.strip() for s in (r.stdout+r.stderr).splitlines() if 'not found' in s]
  if missing: bad.append({'file':str(p.relative_to(root)),'missing':missing})
print(json.dumps({'nativeModulesChecked':checked,'unresolved':bad},indent=2))
PY
