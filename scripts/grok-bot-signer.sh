#!/bin/sh
# Start, stop, and health-check evalanche-signer on the Grok Bot box.
# No systemd unit. The wallet key stays in the environment and is never written here.
set -eu

PREFIX=/opt/evalanche-signer
CONFIG=/etc/evalanche-signer/config.json
STATE=/var/lib/evalanche-signer/state
LOG_DIR=/var/lib/evalanche-signer/log
SOCKET_DIR=/var/lib/evalanche-signer/run
SOCKET=$SOCKET_DIR/signer.sock
PIDFILE=$STATE/signer.pid
LOG=$LOG_DIR/signer.log
SIGNER_USER=evalanche-signer
BIN=$PREFIX/node_modules/.bin/evalanche-signer

usage() {
  echo "usage: grok-bot-signer.sh start [--dry-run] | stop | health" >&2
  exit 2
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "grok-bot-signer.sh must run as root (the box user uses passwordless sudo)" >&2
    exit 1
  fi
}

require_layout() {
  if ! id "$SIGNER_USER" >/dev/null 2>&1; then
    echo "missing user $SIGNER_USER" >&2
    exit 1
  fi
  if [ ! -x "$BIN" ]; then
    echo "missing $BIN" >&2
    exit 1
  fi
  if [ ! -f "$CONFIG" ]; then
    echo "missing $CONFIG" >&2
    exit 1
  fi
}

start_signer() {
  require_root
  require_layout
  dry=""
  if [ "${1:-}" = "--dry-run" ]; then
    dry="--dry-run"
  elif [ -n "${1:-}" ]; then
    usage
  fi
  if [ -z "${EVALANCHE_SIGNER_PRIVATE_KEY:-}" ]; then
    echo "EVALANCHE_SIGNER_PRIVATE_KEY is required" >&2
    exit 1
  fi
  if [ -z "${EVALANCHE_SIGNER_TOKEN:-}" ]; then
    echo "EVALANCHE_SIGNER_TOKEN is required" >&2
    exit 1
  fi
  if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      echo "signer already running ($old)" >&2
      exit 1
    fi
  fi
  flags=""
  if [ ! -f "$STATE/nonces.json" ]; then
    flags="--init-nonces"
  fi
  if [ -n "$dry" ]; then
    flags="$flags --dry-run"
  fi
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    echo "systemd is installed. This release still starts the signer with this script." >&2
  fi
  # preserve-env keeps the key out of argv. The signer deletes it from its own environment after reading it.
  # shellcheck disable=SC2086
  sudo -n --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN \
    -u "$SIGNER_USER" -- \
    sh -c 'umask 077; echo $$ > "$1"; shift; exec "$1" --config "$2" --socket "$3" $4 >>"$5" 2>&1' \
    sh "$PIDFILE" "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" &
  i=0
  while [ ! -S "$SOCKET" ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  if [ ! -S "$SOCKET" ]; then
    echo "signer socket did not appear; see $LOG" >&2
    exit 1
  fi
  echo "signer started"
}

stop_signer() {
  require_root
  if [ ! -f "$PIDFILE" ]; then
    echo "signer is not running"
    exit 0
  fi
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do
      i=$((i + 1))
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE"
  echo "signer stopped"
}

health_signer() {
  if [ ! -S "$SOCKET" ]; then
    echo "signer socket is missing" >&2
    exit 1
  fi
  node -e '
    const http = require("node:http");
    const socketPath = process.argv[1];
    const req = http.request({ socketPath, path: "/health", method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        process.stdout.write(Buffer.concat(chunks).toString("utf8") + "\n");
        process.exit(res.statusCode === 200 ? 0 : 1);
      });
    });
    req.on("error", (error) => {
      process.stderr.write(error.message + "\n");
      process.exit(1);
    });
    req.end();
  ' "$SOCKET"
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) start_signer "$@" ;;
  stop) stop_signer ;;
  health) health_signer ;;
  *) usage ;;
esac
