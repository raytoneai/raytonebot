#!/usr/bin/env bash
# RaytoneBot on AgentMatrix: the in-Environment half of the deployment (RT-01).
#
# The platform has no public exec API, so a managed Session's shell runs this
# script. It is the only command the agent is asked to run, and it is uploaded
# from this repository before the Session starts, never typed by the model.
#
#   bootstrap.sh install                    verify + extract the published release, npm ci
#   bootstrap.sh start   <public-origin>    write env, start, wait for health
#   bootstrap.sh stop                       stop the keeper and the server
#   bootstrap.sh status                     print health and the last log line
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

health() {
  [ -f "$ENV_FILE" ] || return 1
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  curl -fsS -m 5 -u "raytonebot:${RAYTONEBOT_PASSWORD}" "$HEALTH_URL"
}

install_release() {
  local sha_file="$AM_DIR/release.sha256"
  [ -f "$sha_file" ] || fail "missing $sha_file (publish the release first)"
  [ -d "$AM_DIR/release" ] || fail "missing $AM_DIR/release (publish the release first)"
  mkdir -p "$AM_DIR" "$DATA_DIR" "$LOG_DIR"
  write_keepalive

  cat "$AM_DIR"/release/part-* >"$AM_DIR/release.tgz"
  local expected
  expected=$(tr -d '[:space:]' <"$sha_file")
  local actual
  actual=$(sha256sum "$AM_DIR/release.tgz" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || fail "release checksum mismatch ($actual != $expected)"

  local stage="$APP_DIR.stage"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$AM_DIR/release.tgz" -C "$stage" || fail "cannot extract the release"
  [ -f "$stage/scripts/cloud-preview.mjs" ] || fail "archive has no scripts/cloud-preview.mjs"
  [ -f "$stage/dist/index.html" ] || fail "archive has no dist/index.html"

  log "installing dependencies"
  ( cd "$stage" && npm ci --no-audit --no-fund --loglevel=error ) >>"$LOG_DIR/install.out" 2>&1 ||
    fail "npm ci failed; see $LOG_DIR/install.out"

  rm -rf "$APP_DIR.previous"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.previous"
  mv "$stage" "$APP_DIR"
  rm -rf "$APP_DIR.previous"
  stop_app >/dev/null 2>&1 || true
  printf 'installed %s %s\n' "$(date -u +%FT%TZ)" "$expected" >"$AM_DIR/install.ok"
  log "AM_INSTALLED"
}

start_app() {
  local origin=${1:?usage: bootstrap.sh start <public-origin>}
  case "$origin" in https://*) ;; *) fail "public origin must be https (got $origin)" ;; esac
  [ -f "$AM_DIR/install.ok" ] || fail "run install first"
  if [ ! -f "$AM_DIR/secrets.env" ] && [ ! -f "$ENV_FILE" ]; then
    fail "missing $AM_DIR/secrets.env (publish secrets first)"
  fi
  if health >/dev/null 2>&1; then
    if grep -qsF " $origin" "$AM_DIR/listening.ok"; then
      log "already running on this origin"
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
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup bash "$KEEPALIVE" >>"$LOG_DIR/keepalive.out" 2>&1 &
  else
    nohup bash "$KEEPALIVE" >>"$LOG_DIR/keepalive.out" 2>&1 &
  fi
  echo $! >"$AM_DIR/keepalive.pid"
  cd - >/dev/null
  log "started keeper pid $(cat "$AM_DIR/keepalive.pid")"

  for _ in $(seq 1 90); do
    if health >/dev/null 2>&1; then
      printf 'listening %s %s\n' "$(date -u +%FT%TZ)" "$origin" >"$AM_DIR/listening.ok"
      health
      printf '\n'
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

case "${1:-}" in
  install) install_release ;;
  start) start_app "${2:-}" ;;
  stop) stop_app ;;
  status)
    health || { log "not healthy"; exit 1; }
    printf '\n'
    tail -n 1 "$LOG_DIR/preview.out" 2>/dev/null || true
    ;;
  *) fail "usage: bootstrap.sh install | start <origin> | stop | status" ;;
esac
