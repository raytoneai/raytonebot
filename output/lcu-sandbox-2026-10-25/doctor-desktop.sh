set -u
trial_dir=/home/user/lcu-trial
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' dbus-run-session -- bash -c '
  set -u
  openbox > /home/user/lcu-trial/openbox.log 2>&1 &
  wm_pid=$!
  trap "kill $wm_pid 2>/dev/null || true" EXIT
  LCU_NO_UPDATE_CHECK=1 /home/user/lcu-trial/installed/current/bin/lcu doctor
  result=$?
  printf "doctor_exit=%s\n" "$result"
  exit "$result"
'
