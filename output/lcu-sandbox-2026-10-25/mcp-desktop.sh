set -eu
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' dbus-run-session -- bash -c '
  openbox > /home/user/lcu-trial/openbox-mcp.log 2>&1 &
  wm_pid=$!
  trap "kill $wm_pid 2>/dev/null || true" EXIT
  python3 /home/user/lcu-trial/mcp-probe.py
'
