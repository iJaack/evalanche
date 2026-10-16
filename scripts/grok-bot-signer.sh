#!/bin/sh
# Start, stop, and health-check evalanche-signer on the Grok Bot box.
# No systemd unit. The wallet key stays in the environment and is never written here.
# start is dry-run unless --live is passed. The bearer token is read from a file.
# As root, EVALANCHE_BOX_* overrides are ignored and the production paths are used.
set -eu

if [ "$(id -u)" -eq 0 ]; then
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
  TOKEN_FILE=/etc/evalanche-signer/token
  LOCK=$STATE/start.lock
  SKIP_ROOT=0
else
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
  LOCK=${EVALANCHE_BOX_LOCK:-$STATE/start.lock}
  SKIP_ROOT=${EVALANCHE_BOX_SKIP_ROOT:-0}
fi

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
  if ! command -v flock >/dev/null 2>&1; then
    echo "flock is required" >&2
    exit 1
  fi
}

# Set once in this shell. Callers must not read it through a nested subshell.
SIGNER_UID=""
ensure_signer_uid() {
  if [ -n "$SIGNER_UID" ]; then
    return 0
  fi
  SIGNER_UID=$(id -u "$SIGNER_USER")
}

# A zombie still answers kill -0. In a container, pid 1 may not reap it.
# Stop treats that process as gone.
pid_is_live() {
  raw=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${raw#*)}
  rest=${rest# }
  state=${rest%% *}
  [ -n "$state" ] && [ "$state" != "Z" ]
}

# A signer process has the signer uid and a command line that is the
# configured binary or signer/cli.mjs. Wrappers (sh, sudo, setsid) do not count.
is_signer_pid() {
  pid=$1
  [ -n "$SIGNER_UID" ] || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  uid=$(awk '/^Uid:/ { print $2; exit }' "/proc/$pid/status" 2>/dev/null) || return 1
  [ "$uid" = "$SIGNER_UID" ] || return 1
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

# Live signer pids only. A zombie is not running.
list_signer_pids() {
  ensure_signer_uid
  for dir in /proc/[0-9]*; do
    [ -d "$dir" ] || continue
    pid=${dir#/proc/}
    pid_is_live "$pid" || continue
    if is_signer_pid "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
  return 0
}

# The mark is in the child environment, not in its argv.
pid_has_mark() {
  pid=$1
  [ -r "/proc/$pid/environ" ] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -F -x -q "EVALANCHE_SIGNER_START_MARK=$START_MARK"
}

find_marked_pid() {
  for dir in /proc/[0-9]*; do
    [ -d "$dir" ] || continue
    pid=${dir#/proc/}
    pid_is_live "$pid" || continue
    is_signer_pid "$pid" || continue
    if pid_has_mark "$pid"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
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

# Blocking exclusive lock for the whole start. The second start waits, then
# sees the signer and fails. The lockfile is root-owned when this script is root.
hold_start_lock() {
  if [ "$(id -u)" -eq 0 ]; then
    touch "$LOCK"
    chown root:root "$LOCK"
    chmod 0600 "$LOCK"
  fi
  exec 9>"$LOCK"
  flock 9
}

launch_signer() {
  flags=$1
  # Prefix assignment puts the mark in the environment. It is not an argument.
  if [ "$SKIP_ROOT" = 1 ]; then
    # shellcheck disable=SC2086
    EVALANCHE_SIGNER_START_MARK=$START_MARK \
      sh -c 'umask 077; exec 9>&-; exec setsid "$1" --config "$2" --socket "$3" $4 >>"$5" 2>&1 </dev/null' \
      sh "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" &
  else
    # shellcheck disable=SC2086
    EVALANCHE_SIGNER_START_MARK=$START_MARK \
      sudo -n --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN,EVALANCHE_SIGNER_START_MARK \
      -u "$SIGNER_USER" -- \
      sh -c 'umask 077; exec 9>&-; exec setsid "$1" --config "$2" --socket "$3" $4 >>"$5" 2>&1 </dev/null' \
      sh "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" &
  fi
  launcher=$!
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
  hold_start_lock
  if [ -z "${EVALANCHE_SIGNER_PRIVATE_KEY:-}" ]; then
    echo "EVALANCHE_SIGNER_PRIVATE_KEY is required" >&2
    exit 1
  fi
  read_token
  ensure_signer_uid
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
  START_MARK=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  launch_signer "$flags"
  newpid=""
  i=0
  while [ "$i" -lt 100 ]; do
    newpid=$(find_marked_pid || true)
    if [ -n "$newpid" ]; then
      break
    fi
    # The launcher is gone and this start has no marked child. setsid may
    # have forked, so look once more, then stop instead of scanning the
    # rest of the wait.
    if ! pid_is_live "$launcher"; then
      sleep 0.1
      newpid=$(find_marked_pid || true)
      break
    fi
    i=$((i + 1))
    sleep 0.1
  done
  if [ -z "$newpid" ]; then
    echo "signer process did not start; see $LOG" >&2
    exit 1
  fi
  ready=0
  i=0
  while [ "$i" -lt 100 ]; do
    if is_signer_pid "$newpid" && socket_held_by "$newpid" && probe_health >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! pid_is_live "$newpid"; then
      echo "signer process $newpid exited; see $LOG" >&2
      exit 1
    fi
    i=$((i + 1))
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    echo "signer pid $newpid did not answer /health; see $LOG" >&2
    if is_signer_pid "$newpid"; then
      kill -TERM "$newpid" 2>/dev/null || true
    fi
    exit 1
  fi
  if ! is_signer_pid "$newpid" || ! pid_has_mark "$newpid" || ! socket_held_by "$newpid"; then
    echo "signer pid $newpid is not the process listening on $SOCKET" >&2
    exit 1
  fi
  printf '%s\n' "$newpid" > "$PIDFILE.tmp"
  mv "$PIDFILE.tmp" "$PIDFILE"
  echo "signer started"
}

# Signal one verified pid and return 0 when it is gone (including a zombie).
signal_and_wait() {
  pid=$1
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while pid_is_live "$pid" && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  if pid_is_live "$pid"; then
    echo "signer pid $pid is still alive" >&2
    return 1
  fi
  return 0
}

stop_signer() {
  require_root
  if ! id "$SIGNER_USER" >/dev/null 2>&1; then
    echo "missing user $SIGNER_USER" >&2
    exit 1
  fi
  ensure_signer_uid
  pid=""
  if [ -f "$PIDFILE" ]; then
    pid=$(tr -d ' \n\r' < "$PIDFILE" 2>/dev/null || true)
  fi
  # A live pid in the pidfile is stopped only when it is this signer.
  # An unverified live pid is left alone. Missing, empty, stale, or zombie
  # pidfiles fall through to a scan of verified signer processes.
  if [ -n "$pid" ] && pid_is_live "$pid"; then
    if ! is_signer_pid "$pid"; then
      echo "refusing to stop unverified pid $pid" >&2
      exit 1
    fi
    if ! signal_and_wait "$pid"; then
      exit 1
    fi
    rm -f "$PIDFILE"
    echo "signer stopped"
    return 0
  fi
  running=$(list_signer_pids)
  if [ -z "$running" ]; then
    rm -f "$PIDFILE"
    echo "signer is not running"
    exit 0
  fi
  for candidate in $running; do
    if is_signer_pid "$candidate"; then
      kill -TERM "$candidate" 2>/dev/null || true
    fi
  done
  i=0
  while [ "$i" -lt 50 ]; do
    left=$(list_signer_pids)
    if [ -z "$left" ]; then
      break
    fi
    i=$((i + 1))
    sleep 0.1
  done
  left=$(list_signer_pids)
  if [ -n "$left" ]; then
    echo "signer pid still alive: $left" >&2
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
