#!/bin/sh
# Start, stop, health-check, and provision evalanche-signer on the Grok Bot box.
# No systemd unit. The wallet key stays in the environment and is never written here.
# start is dry-run unless --live is passed. The bearer token is read from a file.
# /etc, /opt, and /var do not survive a reset. Only /home does. Durable nonce,
# audit, verifier, token, config, and the pinned tarball live under
# /home/box/agent-data/evalanche-persist. provision recreates the user, /opt,
# and /etc from that directory. It does not regenerate keys or reset nonces.
# There is no boot hook. As root, EVALANCHE_BOX_* overrides are ignored.
set -eu

# Pinned so a recreated user still owns the nonce files that survived the reboot.
SIGNER_UID_PIN=960
SIGNER_GID_PIN=960
SIGNER_GROUP=evalanche-signer

if [ "$(id -u)" -eq 0 ]; then
  PREFIX=/opt/evalanche-signer
  DURABLE=/home/box/agent-data/evalanche-persist
  ETC=/etc/evalanche-signer
  EPHEMERAL=/var/lib/evalanche-signer
  CONFIG=$DURABLE/config.json
  STATE=$DURABLE/state
  NONCE_FILE=$STATE/nonces.json
  AUDIT_FILE=$STATE/audit.jsonl
  LOG_DIR=$EPHEMERAL/log
  SOCKET_DIR=$EPHEMERAL/run
  SOCKET=$SOCKET_DIR/signer.sock
  PIDFILE=$STATE/signer.pid
  LOG=$LOG_DIR/signer.log
  SIGNER_USER=evalanche-signer
  BIN=$PREFIX/node_modules/.bin/evalanche-signer
  TOKEN_FILE=$DURABLE/token
  VERIFIER_KEY=$DURABLE/verifier.key
  VERIFIER_PUB=$DURABLE/verifier.pub
  TARBALL=$DURABLE/evalanche-1.15.0.tgz
  LOCK=$STATE/start.lock
  SKIP_ROOT=0
else
  PREFIX=${EVALANCHE_BOX_PREFIX:-/opt/evalanche-signer}
  DURABLE=${EVALANCHE_BOX_DURABLE:-/home/box/agent-data/evalanche-persist}
  ETC=${EVALANCHE_BOX_ETC:-/etc/evalanche-signer}
  EPHEMERAL=${EVALANCHE_BOX_EPHEMERAL:-/var/lib/evalanche-signer}
  STATE=${EVALANCHE_BOX_STATE:-$DURABLE/state}
  NONCE_FILE=${EVALANCHE_BOX_NONCE:-$STATE/nonces.json}
  AUDIT_FILE=${EVALANCHE_BOX_AUDIT:-$STATE/audit.jsonl}
  CONFIG=${EVALANCHE_BOX_CONFIG:-$DURABLE/config.json}
  LOG_DIR=${EVALANCHE_BOX_LOG_DIR:-$EPHEMERAL/log}
  SOCKET_DIR=${EVALANCHE_BOX_SOCKET_DIR:-$EPHEMERAL/run}
  SOCKET=${EVALANCHE_BOX_SOCKET:-$SOCKET_DIR/signer.sock}
  PIDFILE=${EVALANCHE_BOX_PIDFILE:-$STATE/signer.pid}
  LOG=${EVALANCHE_BOX_LOG:-$LOG_DIR/signer.log}
  SIGNER_USER=${EVALANCHE_BOX_USER:-evalanche-signer}
  BIN=${EVALANCHE_BOX_BIN:-$PREFIX/node_modules/.bin/evalanche-signer}
  TOKEN_FILE=${EVALANCHE_BOX_TOKEN_FILE:-$DURABLE/token}
  VERIFIER_KEY=${EVALANCHE_BOX_VERIFIER_KEY:-$DURABLE/verifier.key}
  VERIFIER_PUB=${EVALANCHE_BOX_VERIFIER_PUB:-$DURABLE/verifier.pub}
  TARBALL=${EVALANCHE_BOX_TARBALL:-$DURABLE/evalanche-1.15.0.tgz}
  LOCK=${EVALANCHE_BOX_LOCK:-$STATE/start.lock}
  SKIP_ROOT=${EVALANCHE_BOX_SKIP_ROOT:-0}
fi

usage() {
  echo "usage: grok-bot-signer.sh start [--live] | init [--live] | stop | health | provision [tarball] [sha256]" >&2
  echo "start and init are dry-run unless --live is passed. init also passes --init-nonces." >&2
  echo "provision recreates the user, /opt, and /etc from the persistent directory." >&2
  echo "It does not regenerate a verifier key or reset a nonce store that already exists." >&2
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

make_dir() {
  path=$1
  owner=$2
  group=$3
  mode=$4
  if [ "$SKIP_ROOT" = 1 ]; then
    mkdir -p "$path"
    chmod "$mode" "$path"
    return 0
  fi
  install -d -o "$owner" -g "$group" -m "$mode" "$path"
}

# Recreate the account at the pinned ids. A new uid would orphan the nonce files.
ensure_signer_account() {
  if [ "$SKIP_ROOT" = 1 ]; then
    return 0
  fi
  taken=$(getent group "$SIGNER_GID_PIN" | cut -d: -f1 || true)
  if [ -n "$taken" ] && [ "$taken" != "$SIGNER_GROUP" ]; then
    echo "gid $SIGNER_GID_PIN is already used by group $taken" >&2
    exit 1
  fi
  if getent group "$SIGNER_GROUP" >/dev/null 2>&1; then
    gid=$(getent group "$SIGNER_GROUP" | cut -d: -f3)
    if [ "$gid" != "$SIGNER_GID_PIN" ]; then
      echo "group $SIGNER_GROUP exists with gid $gid, expected $SIGNER_GID_PIN" >&2
      exit 1
    fi
  else
    groupadd --system --gid "$SIGNER_GID_PIN" "$SIGNER_GROUP"
  fi
  taken=$(getent passwd "$SIGNER_UID_PIN" | cut -d: -f1 || true)
  if [ -n "$taken" ] && [ "$taken" != "$SIGNER_USER" ]; then
    echo "uid $SIGNER_UID_PIN is already used by user $taken" >&2
    exit 1
  fi
  if id "$SIGNER_USER" >/dev/null 2>&1; then
    uid=$(id -u "$SIGNER_USER")
    gid=$(id -g "$SIGNER_USER")
    if [ "$uid" != "$SIGNER_UID_PIN" ] || [ "$gid" != "$SIGNER_GID_PIN" ]; then
      echo "user $SIGNER_USER exists as $uid:$gid, expected $SIGNER_UID_PIN:$SIGNER_GID_PIN" >&2
      exit 1
    fi
  else
    useradd --system --uid "$SIGNER_UID_PIN" --gid "$SIGNER_GID_PIN" \
      --no-create-home --home-dir "$EPHEMERAL" --shell /bin/false "$SIGNER_USER"
  fi
  if id box >/dev/null 2>&1; then
    usermod -aG "$SIGNER_GROUP" box
  fi
}

assert_under_durable() {
  label=$1
  path=$2
  case "$path" in
    "$DURABLE"/*) ;;
    *)
      echo "$label must stay under $DURABLE" >&2
      exit 1
      ;;
  esac
}

assert_config_paths() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const durable = path.resolve(process.argv[2]);
    for (const key of ["nonceStorePath", "auditLogPath", "verifierPublicKeyPath"]) {
      const value = cfg[key];
      if (typeof value !== "string") {
        console.error(key + " must be a path under " + durable);
        process.exit(1);
      }
      const resolved = path.resolve(value);
      if (resolved !== durable && !resolved.startsWith(durable + path.sep)) {
        console.error(key + " must stay under " + durable);
        process.exit(1);
      }
    }
  ' "$CONFIG" "$DURABLE"
}

write_config_template() {
  cat > "$CONFIG.tmp" <<EOF
{
  "chainId": 43114,
  "socketPath": "$SOCKET",
  "auditLogPath": "$AUDIT_FILE",
  "nonceStorePath": "$NONCE_FILE",
  "verifierPublicKeyPath": "$VERIFIER_PUB",
  "allow": {
    "43114": [
      { "address": "0x0000000000000000000000000000000000000001", "selectors": ["0x"], "roles": ["recipient"] }
    ]
  }
}
EOF
  chmod 0644 "$CONFIG.tmp"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$CONFIG.tmp"
  fi
  mv "$CONFIG.tmp" "$CONFIG"
}

install_pinned_tarball() {
  tarball=$1
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install the pinned tarball" >&2
    exit 1
  fi
  npm install --prefix "$PREFIX" --omit=dev --ignore-scripts "$tarball"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown -R root:root "$PREFIX"
  fi
  chmod -R u+rwX,go+rX,go-w "$PREFIX"
  packaged=$PREFIX/node_modules/evalanche/scripts/grok-bot-signer.sh
  if [ ! -f "$packaged" ] || [ -L "$packaged" ]; then
    echo "tarball did not install grok-bot-signer.sh" >&2
    exit 1
  fi
  if [ "$SKIP_ROOT" = 1 ]; then
    mkdir -p "$PREFIX/bin" "$DURABLE/bin"
    cp "$packaged" "$PREFIX/bin/grok-bot-signer.sh"
    cp "$packaged" "$DURABLE/bin/grok-bot-signer.sh"
    chmod 0755 "$PREFIX/bin/grok-bot-signer.sh" "$DURABLE/bin/grok-bot-signer.sh"
  else
    install -D -o root -g root -m 0755 "$packaged" "$PREFIX/bin/grok-bot-signer.sh"
    install -D -o root -g root -m 0755 "$packaged" "$DURABLE/bin/grok-bot-signer.sh"
  fi
}

# Copy one persistent file onto the recreated /etc tree. Never creates a key,
# and never writes back into the persistent directory.
restore_etc_file() {
  src=$1
  dest=$2
  mode=$3
  group=$4
  if [ ! -f "$src" ] || [ -L "$src" ]; then
    return 0
  fi
  if [ -L "$dest" ]; then
    echo "refusing to follow symlink $dest" >&2
    exit 1
  fi
  cp "$src" "$dest.tmp"
  chmod "$mode" "$dest.tmp"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown "root:$group" "$dest.tmp"
  fi
  mv "$dest.tmp" "$dest"
}

restore_etc() {
  make_dir "$ETC" root root 0755
  restore_etc_file "$CONFIG" "$ETC/config.json" 0644 root
  restore_etc_file "$VERIFIER_KEY" "$ETC/verifier.key" 0600 root
  restore_etc_file "$VERIFIER_PUB" "$ETC/verifier.pub" 0644 root
  restore_etc_file "$TOKEN_FILE" "$ETC/token" 0640 "$SIGNER_GROUP"
}

pin_tarball() {
  src=$1
  if [ "$src" = "$TARBALL" ]; then
    return 0
  fi
  cp "$src" "$TARBALL.new"
  chmod 0644 "$TARBALL.new"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$TARBALL.new"
  fi
  mv "$TARBALL.new" "$TARBALL"
}

# Idempotent. Recreates the user, /opt, and /etc from the persistent directory.
# Does not regenerate verifier keys, rewrite the token, or reset nonce or audit files.
provision_signer() {
  src=${1:-}
  digest=${2:-}
  if [ -n "${3:-}" ]; then
    usage
  fi
  if [ -z "$src" ]; then
    src=$TARBALL
  fi
  require_root
  if [ "$SKIP_ROOT" != 1 ]; then
    case "$DURABLE" in
      /home/*) ;;
      *)
        echo "durable signer state must live under /home" >&2
        exit 1
        ;;
    esac
  fi
  assert_under_durable "nonce file" "$NONCE_FILE"
  assert_under_durable "audit log" "$AUDIT_FILE"
  assert_under_durable "config" "$CONFIG"
  assert_under_durable "token file" "$TOKEN_FILE"
  assert_under_durable "verifier key" "$VERIFIER_KEY"
  assert_under_durable "verifier pubkey" "$VERIFIER_PUB"
  assert_under_durable "pinned tarball" "$TARBALL"
  if [ ! -f "$src" ] || [ -L "$src" ]; then
    echo "provision requires the pinned tarball at $src" >&2
    exit 1
  fi
  if [ -n "$digest" ]; then
    if ! printf '%s' "$digest" | grep -E -q '^[0-9a-f]{64}$'; then
      echo "tarball sha256 must be 64 hex characters" >&2
      exit 1
    fi
    actual=$(sha256sum "$src" | awk 'NR==1 { print $1 }')
    if [ "$actual" != "$digest" ]; then
      echo "tarball sha256 does not match" >&2
      exit 1
    fi
  fi
  if [ -L "$CONFIG" ] || [ -L "$STATE" ] || [ -L "$DURABLE" ] || [ -L "$NONCE_FILE" ] || [ -L "$AUDIT_FILE" ]; then
    echo "durable signer paths must not be symlinks" >&2
    exit 1
  fi
  ensure_signer_account
  make_dir "$DURABLE" root root 0755
  make_dir "$DURABLE/bin" root root 0755
  make_dir "$STATE" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$EPHEMERAL" root root 0755
  make_dir "$PREFIX" root root 0755
  make_dir "$LOG_DIR" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$SOCKET_DIR" "$SIGNER_USER" "$SIGNER_GROUP" 0750
  if [ -f "$CONFIG" ]; then
    assert_config_paths
  else
    write_config_template
  fi
  pin_tarball "$src"
  install_pinned_tarball "$TARBALL"
  restore_etc
  echo "signer provisioned"
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) run_start 0 "$@" ;;
  init) run_start 1 "$@" ;;
  stop) stop_signer ;;
  health) health_signer ;;
  provision) provision_signer "$@" ;;
  *) usage ;;
esac
