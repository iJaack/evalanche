#!/bin/sh
# Start, stop, and health-check evalanche-signer on the Grok Bot box.
# No systemd unit. The wallet key stays in the environment and is never written here.
# start is dry-run unless --live is passed. The bearer token is read from a file.
set -eu

PREFIX=${EVALANCHE_BOX_PREFIX:-/opt/evalanche-signer}
CONFIG=${EVALANCHE_BOX_CONFIG:-/etc/evalanche-signer/config.json}
STATE=${EVALANCHE_BOX_STATE:-/var/lib/evalanche-signer/state}
LOG_DIR=${EVALANCHE_BOX_LOG_DIR:-/var/lib/evalanche-signer/log}
SOCKET_DIR=${EVALANCHE_BOX_SOCKET_DIR:-/var/lib/evalanche-signer/run}
SOCKET=${EVALANCHE_BOX_SOCKET:-$SOCKET_DIR/signer.sock}
PIDFILE=${EVALANCHE_BOX_PIDFILE:-$STATE/signer.pid}
LOG=${EVALANCHE_BOX_LOG:-$LOG_DIR/signer.log}
SIGNER_USER=${EVALANCHE_BOX_USER:-evalanche-signer}
BIN=${EVALANCHE_BOX_BIN:-$PREFIX/node_modules/.bin/evalanche-signer}
TOKEN_FILE=${EVALANCHE_BOX_TOKEN_FILE:-/etc/evalanche-signer/token}
SKIP_ROOT=${EVALANCHE_BOX_SKIP_ROOT:-0}

usage() {
  echo "usage: grok-bot-signer.sh start [--live] | init [--live] | stop | health" >&2
  echo "start and init are dry-run unless --live is passed. init also passes --init-nonces." >&2
  exit 2
}

require_root() {
  if [ "$SKIP_ROOT" = 1 ]; then
    return 0
  fi
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
  if [ ! -d "$STATE" ] || [ ! -d "$LOG_DIR" ] || [ ! -d "$SOCKET_DIR" ]; then
    echo "missing state, log, or socket directory" >&2
    exit 1
  fi
  if ! command -v setsid >/dev/null 2>&1; then
    echo "setsid is required" >&2
    exit 1
  fi
}

SIGNER_UID=""

signer_uid() {
  if [ -z "$SIGNER_UID" ]; then
    SIGNER_UID=$(id -u "$SIGNER_USER")
  fi
  printf '%s\n' "$SIGNER_UID"
}

# A signer process has the signer uid and a command line that is the
# configured binary or signer/cli.mjs. Wrappers (sh, sudo, setsid) do not count.
is_signer_pid() {
  pid=$1
  [ -r "/proc/$pid/cmdline" ] || return 1
  uid=$(stat -c %u "/proc/$pid" 2>/dev/null) || return 1
  [ "$uid" = "$(signer_uid)" ] || return 1
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
  [ -n "$cmdline" ] || return 1
  argv0=${cmdline%% *}
  case "$argv0" in
    sh|*/sh|bash|*/bash|dash|*/dash|sudo|*/sudo|setsid|*/setsid) return 1 ;;
  esac
  case "$cmdline" in
    *"$BIN"*|*signer/cli.mjs*) return 0 ;;
  esac
  return 1
}

list_signer_pids() {
  for dir in /proc/[0-9]*; do
    [ -d "$dir" ] || continue
    pid=${dir#/proc/}
    if is_signer_pid "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
  return 0
}

socket_held_by() {
  pid=$1
  [ -S "$SOCKET" ] || return 1
  inode=$(awk -v p="$SOCKET" '$NF == p { print $(NF-1); exit }' /proc/net/unix) || return 1
  [ -n "${inode:-}" ] || return 1
  for fd in /proc/"$pid"/fd/*; do
    [ -L "$fd" ] || continue
    target=$(readlink "$fd" 2>/dev/null) || continue
    if [ "$target" = "socket:[$inode]" ]; then
      return 0
    fi
  done
  return 1
}

read_token() {
  if [ -L "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then
    echo "missing bearer token file $TOKEN_FILE" >&2
    exit 1
  fi
  if [ "$SKIP_ROOT" != 1 ]; then
    owner=$(stat -c %u "$TOKEN_FILE")
    group=$(stat -c %G "$TOKEN_FILE")
    mode=$(stat -c %a "$TOKEN_FILE")
    if [ "$owner" != 0 ] || [ "$group" != "$SIGNER_USER" ] || [ "$mode" != 640 ]; then
      echo "token file must be root:$SIGNER_USER mode 0640" >&2
      exit 1
    fi
  fi
  EVALANCHE_SIGNER_TOKEN=$(tr -d '\n\r' < "$TOKEN_FILE")
  if [ -z "$EVALANCHE_SIGNER_TOKEN" ]; then
    echo "bearer token file is empty" >&2
    exit 1
  fi
  export EVALANCHE_SIGNER_TOKEN
}

probe_health() {
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
    req.on("error", () => process.exit(1));
    req.end();
  ' "$SOCKET"
}

launch_signer() {
  flags=$1
  # The pidfile is not written here. setsid makes the signer a session leader.
  if [ "$SKIP_ROOT" = 1 ]; then
    # shellcheck disable=SC2086
    sh -c 'umask 077; exec setsid "$1" --config "$2" --socket "$3" $4 >>"$5" 2>&1 </dev/null' \
      sh "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" &
  else
    # shellcheck disable=SC2086
    sudo -n --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN \
      -u "$SIGNER_USER" -- \
      sh -c 'umask 077; exec setsid "$1" --config "$2" --socket "$3" $4 >>"$5" 2>&1 </dev/null' \
      sh "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" &
  fi
}

run_start() {
  do_init=$1
  shift
  want_live=0
  if [ "${1:-}" = "--live" ]; then
    want_live=1
    shift
  elif [ -n "${1:-}" ]; then
    usage
  fi
  if [ -n "${1:-}" ]; then
    usage
  fi
  require_root
  require_layout
  if [ -z "${EVALANCHE_SIGNER_PRIVATE_KEY:-}" ]; then
    echo "EVALANCHE_SIGNER_PRIVATE_KEY is required" >&2
    exit 1
  fi
  read_token
  running=$(list_signer_pids)
  if [ -n "$running" ]; then
    echo "signer already running" >&2
    exit 1
  fi
  if [ -e "$SOCKET" ] || [ -S "$SOCKET" ]; then
    rm -f "$SOCKET"
  fi
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    echo "systemd is installed. This release still starts the signer with this script." >&2
  fi
  flags=""
  if [ "$do_init" = 1 ]; then
    flags="--init-nonces"
  fi
  if [ "$want_live" != 1 ]; then
    if [ -n "$flags" ]; then
      flags="$flags --dry-run"
    else
      flags="--dry-run"
    fi
  fi
  launch_signer "$flags"
  newpid=""
  i=0
  while [ "$i" -lt 100 ]; do
    i=$((i + 1))
    found=$(list_signer_pids)
    if [ -n "$found" ]; then
      newpid=$(printf '%s\n' "$found" | awk 'NF { print; exit }')
      break
    fi
    sleep 0.1
  done
  if [ -z "$newpid" ]; then
    echo "signer process did not start; see $LOG" >&2
    exit 1
  fi
  ready=0
  i=0
  while [ "$i" -lt 100 ]; do
    i=$((i + 1))
    if is_signer_pid "$newpid" && socket_held_by "$newpid" && probe_health >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "$newpid" 2>/dev/null; then
      echo "signer process $newpid exited; see $LOG" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    echo "signer pid $newpid did not answer /health; see $LOG" >&2
    if is_signer_pid "$newpid"; then
      kill -TERM "$newpid" 2>/dev/null || true
    fi
    exit 1
  fi
  if ! is_signer_pid "$newpid" || ! socket_held_by "$newpid"; then
    echo "signer pid $newpid is not the process listening on $SOCKET" >&2
    exit 1
  fi
  printf '%s\n' "$newpid" > "$PIDFILE.tmp"
  mv "$PIDFILE.tmp" "$PIDFILE"
  echo "signer started"
}

stop_signer() {
  require_root
  if [ ! -f "$PIDFILE" ]; then
    echo "signer is not running"
    exit 0
  fi
  pid=$(tr -d ' \n\r' < "$PIDFILE" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    echo "pidfile is empty" >&2
    exit 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "signer is not running"
    exit 0
  fi
  if ! id "$SIGNER_USER" >/dev/null 2>&1; then
    echo "missing user $SIGNER_USER" >&2
    exit 1
  fi
  if ! is_signer_pid "$pid"; then
    echo "refusing to stop unverified pid $pid" >&2
    exit 1
  fi
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "signer pid $pid is still alive" >&2
    exit 1
  fi
  rm -f "$PIDFILE"
  echo "signer stopped"
}

health_signer() {
  if [ ! -S "$SOCKET" ]; then
    echo "signer socket is missing" >&2
    exit 1
  fi
  probe_health
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) run_start 0 "$@" ;;
  init) run_start 1 "$@" ;;
  stop) stop_signer ;;
  health) health_signer ;;
  *) usage ;;
esac
