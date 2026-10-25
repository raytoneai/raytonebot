set -eu
manifest=/home/user/.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json
if [ -f "$manifest" ]; then
  mkdir -p /home/user/.config/chromium/NativeMessagingHosts
  cp "$manifest" /home/user/.config/chromium/NativeMessagingHosts/
fi
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' dbus-run-session -- bash -c '
  set -eu
  trial_dir=/home/user/lcu-trial
  openbox > "$trial_dir/openbox-browser.log" 2>&1 &
  wm_pid=$!
  rm -f "$trial_dir/browser-ready.json"
  PLAYWRIGHT_BROWSERS_PATH="$trial_dir/pw-browsers" "$trial_dir/app-root/usr/lib/chatgpt/resources/cua_node/bin/node" "$trial_dir/browser-launch.mjs" > "$trial_dir/browser.log" 2>&1 &
  browser_pid=$!
  cleanup() { kill "$browser_pid" "$wm_pid" 2>/dev/null || true; wait "$browser_pid" "$wm_pid" 2>/dev/null || true; }
  trap cleanup EXIT
  for attempt in $(seq 1 120); do
    if [ -f "$trial_dir/browser-ready.json" ]; then break; fi
    if ! kill -0 "$browser_pid" 2>/dev/null; then cat "$trial_dir/browser.log"; exit 1; fi
    sleep 0.5
  done
  if [ ! -f "$trial_dir/browser-ready.json" ]; then tail -n 35 "$trial_dir/browser.log"; exit 1; fi
  cat "$trial_dir/browser-ready.json"
  python3 "$trial_dir/${LCU_TRIAL_PROBE:-browser-probe.py}"
'
