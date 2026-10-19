#!/usr/bin/env bash
# RaytoneBot on AgentMatrix: the in-Environment half of the deployment (RT-01).
#
# The platform has no public exec API, so a managed Session's shell runs this
# script. The agent runs one short command; the long work (npm ci, health poll)
# is detached here and reported through marker files in the Workspace, so the
# agent's own tool timeout never decides whether the deployment succeeds.
#
#   bootstrap.sh deploy <origin>  install (if needed) + start, synchronously
#   bootstrap.sh install          schedule install; prints AM_INSTALL_STARTED
#   bootstrap.sh start <origin>   schedule start;   prints AM_START_STARTED
#   bootstrap.sh stop             stop the keeper and the server
#   bootstrap.sh status           print health
#
# Markers read by scripts/agentmatrix/deploy.mjs:
#   am/install.ok  am/install.failed  am/listening.ok  am/start.failed
set -euo pipefail

AM_DIR=/workspace/am
APP_DIR=/workspace/raytonebot
STATE_DIR=/workspace/.raytonebot
DATA_DIR="$STATE_DIR/data"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="$STATE_DIR/env"
KEEPALIVE="$AM_DIR/keepalive.sh"
STOP_FILE="$AM_DIR/stopped"
HEALTH_URL=http://127.0.0.1:5188/__agentcanvas/pi/health

log() { printf '[raytonebot] %s\n' "$*"; }
fail() { printf '[raytonebot] FAIL: %s\n' "$*" >&2; exit 1; }

# Backgrounds a command with its output in one log and prints the PID. The log is
# opened here, not by the caller, so `$(spawn ...)` captures the PID instead of
# the command's output.
spawn() {
  local logfile=$1
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >>"$logfile" 2>&1 &
  else
    nohup "$@" >>"$logfile" 2>&1 &
  fi
  echo $!
}

mark_failed() {
  local name=$1 code=$?
  [ "$code" -eq 0 ] && return 0
  {
    printf 'failed %s code %s\n' "$(date -u +%FT%TZ)" "$code"
    tail -n 20 "$LOG_DIR/$name.out" 2>/dev/null || true
  } >"$AM_DIR/$name.failed"
}

write_keepalive() {
  cat >"$KEEPALIVE" <<'KEEPER'
#!/usr/bin/env bash
# Minimal stand-in for scripts/supervisor.py: AgentMatrix's standard image has no
# Python. Restarts Node after an unexpected exit, at most three times in five
# minutes, and never after a requested stop. Not a substitute for AM-01.
set -uo pipefail
APP_DIR=/workspace/raytonebot
LOG=/workspace/.raytonebot/logs/preview.out
STOP_FILE=/workspace/am/stopped
cd "$APP_DIR" || exit 1
starts=0
window_start=$(date +%s)
while :; do
  [ -f "$STOP_FILE" ] && exit 0
  now=$(date +%s)
  if [ $((now - window_start)) -ge 300 ]; then starts=0; window_start=$now; fi
  if [ "$starts" -ge 3 ]; then
    printf '%s restart_limit\n' "$(date -u +%FT%TZ)" >>"$LOG"
    exit 1
  fi
  starts=$((starts + 1))
  printf '%s starting node (attempt %s)\n' "$(date -u +%FT%TZ)" "$starts" >>"$LOG"
  node scripts/cloud-preview.mjs >>"$LOG" 2>&1
  code=$?
  printf '%s node exited %s\n' "$(date -u +%FT%TZ)" "$code" >>"$LOG"
  sleep 2
done
KEEPER
  chmod 700 "$KEEPALIVE"
}

# npm links `file:` dependencies into node_modules. Those links do not survive the
# app directory being replaced, and the file API cannot repair them, so replace
# each one with a real copy of the vendored package.
ensure_vendor_packages() {
  local root=$1 pair link vendored
  for pair in "@agent-ux/protocol:agent-ux/protocol" \
              "@agent-ux/react:agent-ux/react" \
              "@agent-ux/render-core:agent-ux/render-core" \
              "@agent-ux/runtime:agent-ux/runtime" \
              "@agentmatrix/agentcanvas-contract:agentmatrix/agentcanvas-contract"; do
    link=${pair%%:*}
    vendored=${pair#*:}
    if [ -f "$root/node_modules/$link/package.json" ]; then continue; fi
    [ -f "$root/vendor/$vendored/package.json" ] || fail "missing vendored package $vendored"
    log "repairing $link from vendor/$vendored"
    rm -rf "$root/node_modules/$link"
    mkdir -p "$(dirname "$root/node_modules/$link")"
    cp -R "$root/vendor/$vendored" "$root/node_modules/$link"
  done
}

health() {
  [ -f "$ENV_FILE" ] || return 1
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  # The app's gate compares Host with the configured public origin, so a loopback
  # probe has to present that host rather than 127.0.0.1.
  local host=${RAYTONEBOT_PUBLIC_ORIGIN#https://}
  host=${host%/}
  curl -fsS -m 5 -u "raytonebot:${RAYTONEBOT_PASSWORD}" -H "Host: ${host}" "$HEALTH_URL"
}

install_now() {
  trap 'mark_failed install' EXIT
  local sha_file="$AM_DIR/release.sha256"
  if [ -f "$sha_file" ] && [ -f "$AM_DIR/install.ok" ] &&
     grep -qF "$(tr -d '[:space:]' <"$sha_file")" "$AM_DIR/install.ok"; then
    log "release already installed"
    trap - EXIT
    log "AM_INSTALLED"
    return 0
  fi
  local dir_file="$AM_DIR/release.dir"
  [ -f "$sha_file" ] || fail "missing $sha_file (publish the release first)"
  [ -f "$dir_file" ] || fail "missing $dir_file (publish the release first)"
  mkdir -p "$AM_DIR" "$DATA_DIR" "$LOG_DIR"
  write_keepalive

  local release_dir root_dir
  release_dir=$(tr -d '[:space:]' <"$dir_file")
  case "$release_dir" in am/release/*) ;; *) fail "unexpected release directory $release_dir" ;; esac
  root_dir=$(dirname "$AM_DIR")
  cat "$root_dir/$release_dir"/part-* >"$AM_DIR/release.tgz"
  local expected actual
  expected=$(tr -d '[:space:]' <"$sha_file")
  actual=$(sha256sum "$AM_DIR/release.tgz" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || fail "release checksum mismatch ($actual != $expected)"

  local stage="$APP_DIR.stage"
  rm -rf "$stage"
  mkdir -p "$stage"
  local tar_opts=(-xzf "$AM_DIR/release.tgz" -C "$stage")
  if tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'; then
    # Older archives carried macOS extended headers; GNU tar warns once per entry.
    tar_opts=(--warning=no-unknown-keyword "${tar_opts[@]}")
  fi
  tar "${tar_opts[@]}" 2>>"$LOG_DIR/extract.out" || fail "cannot extract the release"
  [ -f "$stage/scripts/cloud-preview.mjs" ] || fail "archive has no scripts/cloud-preview.mjs"
  [ -f "$stage/dist/index.html" ] || fail "archive has no dist/index.html"

  if [ -f "$APP_DIR/node_modules/.raytonebot-complete" ] && cmp -s "$APP_DIR/package-lock.json" "$stage/package-lock.json"; then
    log "reusing node_modules (lockfile unchanged)"
    mv "$APP_DIR/node_modules" "$stage/node_modules"
  else
    log "installing dependencies"
    # The EnvironmentSpec injects NODE_ENV=production, which would otherwise omit
    # vite and the other build-time packages `vite preview` needs.
    ( cd "$stage" && npm ci --include=dev --no-audit --no-fund --loglevel=error ) ||
      fail "npm ci failed; see $LOG_DIR/install.out"
    [ -f "$stage/node_modules/vite/package.json" ] || fail "npm ci finished without vite"
    touch "$stage/node_modules/.raytonebot-complete"
  fi

  ensure_vendor_packages "$stage"

  stop_app >/dev/null 2>&1 || true
  rm -rf "$APP_DIR.previous"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.previous"
  mv "$stage" "$APP_DIR"
  rm -rf "$APP_DIR.previous"
  printf 'installed %s %s\n' "$(date -u +%FT%TZ)" "$expected" >"$AM_DIR/install.ok"
  trap - EXIT
  log "AM_INSTALLED"
}

start_now() {
  trap 'mark_failed start' EXIT
  local origin=${1:?usage: bootstrap.sh start <public-origin>}
  case "$origin" in https://*) ;; *) fail "public origin must be https (got $origin)" ;; esac
  [ -f "$AM_DIR/install.ok" ] || fail "run install first"
  if [ ! -f "$AM_DIR/secrets.env" ] && [ ! -f "$ENV_FILE" ]; then
    fail "missing $AM_DIR/secrets.env (publish secrets first)"
  fi
  if health >/dev/null 2>&1; then
    if grep -qsF " $origin" "$AM_DIR/listening.ok"; then
      log "already running on this origin"
      printf 'listening %s %s\n' "$(date -u +%FT%TZ)" "$origin" >"$AM_DIR/listening.ok"
      trap - EXIT
      log "AM_LISTENING"
      return 0
    fi
    log "origin changed; restarting the server"
    stop_app
  fi

  local umask_before
  umask_before=$(umask)
  umask 077
  if [ -f "$AM_DIR/secrets.env" ]; then
    {
      printf 'RAYTONEBOT_PUBLIC_ORIGIN=%s\n' "$origin"
      printf 'RAYTONEBOT_DATA_DIR=%s\n' "$DATA_DIR"
      printf 'RAYTONEBOT_WORKSPACE_ROOT=/workspace\n'
      printf 'RAYTONEBOT_TRUST_PROXY_ORIGIN=1\n'
      printf 'RAYTONEBOT_PREVIEW_INGRESS=1\n'
      printf 'NODE_ENV=production\n'
      cat "$AM_DIR/secrets.env"
    } >"$ENV_FILE"
    rm -f "$AM_DIR/secrets.env"
  else
    # A redeploy only changes the entry origin; the private env stays as it was.
    local rotated="$ENV_FILE.next"
    grep -v '^RAYTONEBOT_PUBLIC_ORIGIN=' "$ENV_FILE" >"$rotated"
    printf 'RAYTONEBOT_PUBLIC_ORIGIN=%s\n' "$origin" >>"$rotated"
    mv "$rotated" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  umask "$umask_before"

  rm -f "$STOP_FILE"
  write_keepalive
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  cd "$APP_DIR"
  local pid
  pid=$(spawn "$LOG_DIR/keepalive.out" bash "$KEEPALIVE")
  echo "$pid" >"$AM_DIR/keepalive.pid"
  cd - >/dev/null
  log "started keeper pid $pid"

  for _ in $(seq 1 90); do
    if health >/dev/null 2>&1; then
      health
      printf '\n'
      printf 'listening %s %s\n' "$(date -u +%FT%TZ)" "$origin" >"$AM_DIR/listening.ok"
      trap - EXIT
      log "AM_LISTENING"
      return 0
    fi
    sleep 1
  done
  tail -n 20 "$LOG_DIR/preview.out" 2>/dev/null >&2 || true
  fail "health did not answer within 90s"
}

stop_app() {
  touch "$STOP_FILE"
  if [ -f "$AM_DIR/keepalive.pid" ]; then
    kill "$(cat "$AM_DIR/keepalive.pid")" 2>/dev/null || true
  fi
  pkill -f '[c]loud-preview.mjs' 2>/dev/null || true
  rm -f "$AM_DIR/keepalive.pid"
  log "stopped"
}

schedule() {
  local name=$1
  shift
  mkdir -p "$AM_DIR" "$LOG_DIR"
  rm -f "$AM_DIR/$name.ok" "$AM_DIR/$name.failed"
  local pid
  pid=$(spawn "$LOG_DIR/$name.out" bash "$0" "__$name" "$@")
  echo "$pid" >"$AM_DIR/$name.pid"
  log "AM_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')_STARTED"
}

# One synchronous pass for the deployment turn: the Session stays busy for the
# whole npm ci, which is what keeps an idle pause from freezing the machine.
deploy_now() {
  local origin=${1:?usage: bootstrap.sh deploy <public-origin>}
  rm -f "$AM_DIR/install.failed" "$AM_DIR/start.failed"
  local expected=""
  [ -f "$AM_DIR/release.sha256" ] && expected=$(tr -d '[:space:]' <"$AM_DIR/release.sha256")
  if [ -n "$expected" ] && [ -f "$AM_DIR/install.ok" ] && grep -qF "$expected" "$AM_DIR/install.ok"; then
    log "release already installed"
  else
    install_now
  fi
  start_now "$origin"
}

case "${1:-}" in
  deploy) deploy_now "${2:-}" ;;
  install) schedule install ;;
  start) schedule start "${2:-}" ;;
  __install) install_now ;;
  __start) start_now "${2:-}" ;;
  stop) stop_app ;;
  status)
    health || { log "not healthy"; exit 1; }
    printf '\n'
    tail -n 1 "$LOG_DIR/preview.out" 2>/dev/null || true
    ;;
  *) fail "usage: bootstrap.sh install | start <origin> | stop | status" ;;
esac
