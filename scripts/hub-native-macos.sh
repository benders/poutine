#!/usr/bin/env bash
# Run the Poutine hub natively on macOS while keeping Navidrome in Docker.
#
# Why this exists:
#   Sonos casting needs UDP multicast (SSDP). Docker Desktop on macOS does
#   not forward multicast into containers — even with the experimental
#   "host networking" toggle enabled — so the hub must run on the Mac's
#   own network stack to discover Sonos devices. Navidrome stays in Docker
#   (host network, loopback-bound) and the hub reaches it on 127.0.0.1:4533.
#
# Production target is Linux, where `docker-compose.sonos.yml` works fully.
# This script is the macOS-only escape hatch until #183 lands proper
# packaging (launchd, etc.).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PID_FILE="$ROOT_DIR/.hub-native.pid"
LOG_FILE="$ROOT_DIR/.hub-native.log"
DATA_DIR="$ROOT_DIR/data-native"
COMPOSE_FILES=(-f "$ROOT_DIR/docker-compose.yml" -f "$ROOT_DIR/docker-compose.sonos.yml")

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  start     Start Navidrome container + hub native process
  stop      Stop hub native process (Navidrome stays running)
  restart   stop + start, rebuilding hub + frontend
  status    Show PID, /api/health, and Navidrome reachability
  logs      Show last 200 lines of the hub log
  follow    tail -f the hub log
EOF
}

log_info() { printf '[hub-native] %s\n' "$*"; }
log_err()  { printf '[hub-native] ERROR: %s\n' "$*" >&2; }

require_data_dir() {
  if [[ ! -f "$DATA_DIR/poutine.db" ]]; then
    log_err "Missing $DATA_DIR/poutine.db"
    log_err "Copy state from the hub container before first start:"
    log_err "  mkdir -p $DATA_DIR"
    log_err "  docker cp poutine-hub-1:/app/data/poutine.db $DATA_DIR/"
    log_err "  docker cp poutine-hub-1:/app/data/poutine_ed25519.pem $DATA_DIR/"
    log_err "  docker cp poutine-hub-1:/app/data/poutine_password_key $DATA_DIR/"
    exit 1
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

ensure_navidrome() {
  log_info "Ensuring Navidrome container is up (host network, loopback-bound)"
  (cd "$ROOT_DIR" && docker compose "${COMPOSE_FILES[@]}" up -d navidrome >/dev/null)
  # Wait up to 10s for Navidrome /ping
  local i
  for i in $(seq 1 20); do
    if curl -sf --max-time 1 http://127.0.0.1:4533/ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  log_err "Navidrome did not respond on 127.0.0.1:4533 within 10s"
  return 1
}

build_hub() {
  log_info "Building hub + frontend"
  (cd "$ROOT_DIR" && pnpm --filter hub build && pnpm --filter frontend build) >/dev/null
  # tsc doesn't copy schema.sql; the Dockerfile does it post-build. Mirror that here.
  cp "$ROOT_DIR/hub/src/db/"*.sql "$ROOT_DIR/hub/dist/db/"
}

start() {
  if is_running; then
    log_info "Already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  require_data_dir
  ensure_navidrome
  build_hub

  log_info "Starting hub native on :3000"
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env"
  set +a
  export NODE_ENV=production
  export PORT=3000
  export DATABASE_PATH="$DATA_DIR/poutine.db"
  export POUTINE_PRIVATE_KEY_PATH="$DATA_DIR/poutine_ed25519.pem"
  export POUTINE_PASSWORD_KEY_PATH="$DATA_DIR/poutine_password_key"
  export PUBLIC_DIR="$ROOT_DIR/frontend/dist"
  export NAVIDROME_URL="http://127.0.0.1:4533"

  nohup node "$ROOT_DIR/hub/dist/server.js" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    log_err "Hub exited immediately. Last log lines:"
    tail -20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  log_info "Started (pid $pid). Logs: $LOG_FILE"
}

stop() {
  if ! is_running; then
    log_info "Not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  log_info "Stopping pid $pid"
  kill "$pid"
  # Wait up to 5s for graceful exit
  local i
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    log_info "Forcing kill"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

status() {
  if is_running; then
    log_info "Hub running (pid $(cat "$PID_FILE"))"
  else
    log_info "Hub not running"
  fi
  if curl -sf --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    log_info "/api/health: $(curl -s http://127.0.0.1:3000/api/health)"
  else
    log_info "/api/health: unreachable"
  fi
  if curl -sf --max-time 2 http://127.0.0.1:4533/ping >/dev/null 2>&1; then
    log_info "Navidrome /ping: ok"
  else
    log_info "Navidrome /ping: unreachable"
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -200 "$LOG_FILE" ;;
  follow)  tail -f "$LOG_FILE" ;;
  *)       usage; exit 1 ;;
esac
