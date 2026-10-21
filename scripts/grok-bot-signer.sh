#!/bin/sh
# Start, stop, health-check, and provision evalanche-signer on the Grok Bot box.
# No systemd unit. The wallet key stays in the environment and is never written here.
# start is dry-run unless --live is passed. The bearer token is read from a file.
# /etc, /opt, and /var do not survive a reset. Only /home does. Durable nonce,
# audit, verifier pubkey, token, config, and the pinned tarball live under
# /home/box/agent-data/evalanche-persist. A reset restores that tree as the
# box user, so provision chowns it back and fails closed if it cannot.
# State and log are bind-mounted onto /var/lib/evalanche-signer/{state,log}.
# provision recreates the user, /opt, and /etc from the persistent directory.
# It does not regenerate keys or reset nonces. There is no boot hook.
# escrow and restore are opt-in. provision and start do not call them.
# As root, EVALANCHE_BOX_* overrides are ignored.
set -eu

# Neither uid nor gid is pinned. An existing evalanche-signer user and group
# are reused. A missing user gets the first free system uid.
SIGNER_GROUP=evalanche-signer

if [ "$(id -u)" -eq 0 ]; then
  PREFIX=/opt/evalanche-signer
  DURABLE=/home/box/agent-data/evalanche-persist
  ETC=/etc/evalanche-signer
  EPHEMERAL=/var/lib/evalanche-signer
  CONFIG_SRC=$DURABLE/config.json
  CONFIG=$ETC/config.json
  STATE_SRC=$DURABLE/state
  LOG_SRC=$DURABLE/log
  STATE=$EPHEMERAL/state
  NONCE_FILE=$STATE/nonces.json
  AUDIT_FILE=$STATE/audit.jsonl
  LOG_DIR=$EPHEMERAL/log
  SOCKET_DIR=$EPHEMERAL/run
  SOCKET=$SOCKET_DIR/signer.sock
  PIDFILE=$STATE/signer.pid
  LOG=$LOG_DIR/signer.log
  SIGNER_USER=evalanche-signer
  BIN=$PREFIX/dist/signer/cli.mjs
  NODE_FILE=$PREFIX/node.path
  TOKEN_FILE=$DURABLE/token
  VERIFIER_KEY=$DURABLE/verifier.key
  VERIFIER_PUB=$DURABLE/verifier.pub
  LOCK=$STATE/start.lock
  SKIP_ROOT=0
  BOX_USER=box
  BOX_GROUP=box
  OWNERSHIP_STUB=
else
  PREFIX=${EVALANCHE_BOX_PREFIX:-/opt/evalanche-signer}
  DURABLE=${EVALANCHE_BOX_DURABLE:-/home/box/agent-data/evalanche-persist}
  ETC=${EVALANCHE_BOX_ETC:-/etc/evalanche-signer}
  EPHEMERAL=${EVALANCHE_BOX_EPHEMERAL:-/var/lib/evalanche-signer}
  CONFIG_SRC=${EVALANCHE_BOX_CONFIG_SRC:-$DURABLE/config.json}
  CONFIG=${EVALANCHE_BOX_CONFIG:-$ETC/config.json}
  STATE_SRC=${EVALANCHE_BOX_STATE_SRC:-$DURABLE/state}
  LOG_SRC=${EVALANCHE_BOX_LOG_SRC:-$DURABLE/log}
  STATE=${EVALANCHE_BOX_STATE:-$EPHEMERAL/state}
  NONCE_FILE=${EVALANCHE_BOX_NONCE:-$STATE/nonces.json}
  AUDIT_FILE=${EVALANCHE_BOX_AUDIT:-$STATE/audit.jsonl}
  LOG_DIR=${EVALANCHE_BOX_LOG_DIR:-$EPHEMERAL/log}
  SOCKET_DIR=${EVALANCHE_BOX_SOCKET_DIR:-$EPHEMERAL/run}
  SOCKET=${EVALANCHE_BOX_SOCKET:-$SOCKET_DIR/signer.sock}
  PIDFILE=${EVALANCHE_BOX_PIDFILE:-$STATE/signer.pid}
  LOG=${EVALANCHE_BOX_LOG:-$LOG_DIR/signer.log}
  SIGNER_USER=${EVALANCHE_BOX_USER:-evalanche-signer}
  BIN=${EVALANCHE_BOX_BIN:-$PREFIX/dist/signer/cli.mjs}
  NODE_FILE=${EVALANCHE_BOX_NODE_FILE:-$PREFIX/node.path}
  NODE=${EVALANCHE_BOX_NODE:-}
  TOKEN_FILE=${EVALANCHE_BOX_TOKEN_FILE:-$DURABLE/token}
  VERIFIER_KEY=${EVALANCHE_BOX_VERIFIER_KEY:-$DURABLE/verifier.key}
  VERIFIER_PUB=${EVALANCHE_BOX_VERIFIER_PUB:-$DURABLE/verifier.pub}
  LOCK=${EVALANCHE_BOX_LOCK:-$STATE/start.lock}
  SKIP_ROOT=${EVALANCHE_BOX_SKIP_ROOT:-0}
  BOX_USER=${EVALANCHE_BOX_BOX_USER:-box}
  BOX_GROUP=${EVALANCHE_BOX_BOX_GROUP:-box}
  OWNERSHIP_STUB=${EVALANCHE_BOX_OWNERSHIP_STUB:-}
  SIGNER_GROUP=${EVALANCHE_BOX_GROUP:-$SIGNER_GROUP}
fi
# TARBALL and STAGED_TARBALL are set in provision. start does not need them.
# The pinned name is evalanche-<version>.tgz. The version is read from the
# staged tarball's package/package.json after the checksum check. As root,
# EVALANCHE_BOX_TARBALL is ignored.

usage() {
  echo "usage: grok-bot-signer.sh start [--live] | init [--live] | stop | health | provision [tarball] <sha256> | escrow <dir> | restore <dir>" >&2
  echo "start and init are dry-run unless --live is passed. init also passes --init-nonces." >&2
  echo "provision recreates the user, /opt, and /etc from the persistent directory." >&2
  echo "It bind-mounts state and log, chowns the persistent files, and does not regenerate a key or reset a nonce store." >&2
  echo "escrow and restore are off unless those commands are passed. escrow copies the token, the nonce high-water mark, and nonce backups." >&2
  echo "restore checks those hashes and refuses a nonce high-water mark below the current one." >&2
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
  load_node
  if [ -L "$BIN" ] || [ ! -f "$BIN" ]; then
    echo "missing $BIN" >&2
    exit 1
  fi
  if [ ! -x "$NODE" ]; then
    echo "missing node $NODE" >&2
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

# The install records the node binary. Root ignores PATH and EVALANCHE_BOX_NODE.
load_node() {
  if [ "$SKIP_ROOT" = 1 ]; then
    if [ -z "${NODE:-}" ]; then
      NODE=$(command -v node || true)
    fi
    if [ -n "${NODE:-}" ]; then
      resolved=$(readlink -f "$NODE" 2>/dev/null || true)
      if [ -n "$resolved" ]; then
        NODE=$resolved
      fi
    fi
    return 0
  fi
  if [ -L "$NODE_FILE" ] || [ ! -f "$NODE_FILE" ]; then
    echo "missing pinned node" >&2
    exit 1
  fi
  NODE=$(tr -d '\n\r' < "$NODE_FILE")
  if [ -z "$NODE" ] || [ -L "$NODE" ] || [ ! -x "$NODE" ]; then
    echo "pinned node is not executable" >&2
    exit 1
  fi
  assert_root_owned_chain "$NODE"
}

# The recorded node binary and every parent directory must be root-owned
# and not group- or world-writable. A replaced directory on the path would
# otherwise let a later start exec a different binary.
assert_root_owned_chain() {
  path=$1
  while true; do
    if [ -L "$path" ]; then
      echo "pinned node path is a symlink: $path" >&2
      exit 1
    fi
    if [ ! -e "$path" ]; then
      echo "pinned node path is missing: $path" >&2
      exit 1
    fi
    owner=$(stat -c %u "$path")
    if [ "$owner" != 0 ]; then
      echo "pinned node path is not root-owned: $path" >&2
      exit 1
    fi
    mode=$(stat -c %A "$path")
    group_write=$(printf '%s' "$mode" | cut -c6)
    other_write=$(printf '%s' "$mode" | cut -c9)
    if [ "$group_write" = w ] || [ "$other_write" = w ]; then
      echo "pinned node path is group or world writable: $path" >&2
      exit 1
    fi
    if [ "$path" = / ]; then
      break
    fi
    path=$(dirname "$path")
  done
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

# Blocking exclusive lock for the whole start. The lockfile is root-owned
# when this script is root. The child must not keep fd 9: a long-lived sudo
# would hold the flock and the next start would block instead of refusing.
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
  # 9>&- is on sudo and on the daemon shell. The inner exec closes it again
  # before setsid replaces that shell.
  if [ "$SKIP_ROOT" = 1 ]; then
    # shellcheck disable=SC2086
    EVALANCHE_SIGNER_START_MARK=$START_MARK \
      sh -c 'umask 077; exec 9>&-; exec setsid "$1" "$2" --config "$3" --socket "$4" $5 >>"$6" 2>&1 </dev/null' \
      sh "$NODE" "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" 9>&- &
  else
    # shellcheck disable=SC2086
    EVALANCHE_SIGNER_START_MARK=$START_MARK \
      sudo -n --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN,EVALANCHE_SIGNER_START_MARK \
      -u "$SIGNER_USER" -- \
      sh -c 'umask 077; exec 9>&-; exec setsid "$1" "$2" --config "$3" --socket "$4" $5 >>"$6" 2>&1 </dev/null' \
      sh "$NODE" "$BIN" "$CONFIG" "$SOCKET" "$flags" "$LOG" 9>&- &
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
  refuse_verifier_private_key
  require_persistent_mounts
  assert_trusted_files
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
  local path="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  local uid_n gid_n
  if [ -n "$OWNERSHIP_STUB" ]; then
    mkdir -p "$path"
    chmod "$mode" "$path"
    uid_n=$(resolve_id "$owner")
    gid_n=$(resolve_gid "$group")
    if [ -z "$uid_n" ] || [ -z "$gid_n" ]; then
      echo "cannot resolve owner $owner:$group for $path" >&2
      exit 1
    fi
    stub_record "$path" "$uid_n" "$gid_n" "$mode"
    return 0
  fi
  if [ "$SKIP_ROOT" = 1 ]; then
    mkdir -p "$path"
    chmod "$mode" "$path"
    return 0
  fi
  install -d -o "$owner" -g "$group" -m "$mode" "$path"
}

# First free uid in the system range, highest first.
pick_free_system_uid() {
  candidate=999
  while [ "$candidate" -ge 100 ]; do
    if ! getent passwd "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate - 1))
  done
  echo "no free system uid" >&2
  return 1
}

# Reuse the user and the group when they already exist. A box whose
# evalanche-signer user is not uid 960 still provisions.
ensure_signer_account() {
  if [ "$SKIP_ROOT" = 1 ]; then
    return 0
  fi
  if ! getent group "$SIGNER_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SIGNER_GROUP"
  fi
  gid=$(getent group "$SIGNER_GROUP" | cut -d: -f3)
  if [ -z "$gid" ]; then
    echo "cannot resolve gid for group $SIGNER_GROUP" >&2
    exit 1
  fi
  if id "$SIGNER_USER" >/dev/null 2>&1; then
    uid=$(id -u "$SIGNER_USER")
    ugid=$(id -g "$SIGNER_USER")
    # uid 0 is root. The system range on this host is 100-999.
    if [ "$uid" -eq 0 ] || [ "$uid" -lt 100 ] || [ "$uid" -gt 999 ]; then
      echo "refusing to reuse $SIGNER_USER uid $uid outside the system uid range 100-999" >&2
      exit 1
    fi
    if [ "$ugid" != "$gid" ]; then
      echo "user $SIGNER_USER exists as $uid:$ugid, expected primary gid $gid" >&2
      exit 1
    fi
  else
    uid=$(pick_free_system_uid) || exit 1
    useradd --system --uid "$uid" --gid "$gid" \
      --no-create-home --home-dir "$EPHEMERAL" --shell /bin/false "$SIGNER_USER"
  fi
  if [ "$(id -u "$SIGNER_USER")" != "$uid" ] || [ "$(id -g "$SIGNER_USER")" != "$gid" ]; then
    echo "signer account does not match $uid:$gid" >&2
    exit 1
  fi
  if [ "$(getent group "$SIGNER_GROUP" | cut -d: -f3)" != "$gid" ]; then
    echo "group $SIGNER_GROUP gid changed during provision" >&2
    exit 1
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

assert_state_path() {
  label=$1
  path=$2
  case "$path" in
    "$STATE"/*|"$STATE_SRC"/*) return 0 ;;
  esac
  echo "$label must stay under the persistent state directory or its bind mount" >&2
  exit 1
}

resolve_id() {
  if printf '%s' "$1" | grep -E -q '^[0-9]+$'; then
    printf '%s\n' "$1"
  else
    id -u "$1"
  fi
}

resolve_gid() {
  if printf '%s' "$1" | grep -E -q '^[0-9]+$'; then
    printf '%s\n' "$1"
  else
    getent group "$1" | cut -d: -f3
  fi
}

normalize_mode() {
  local stripped
  stripped=$(printf '%s' "$1" | sed 's/^0*//')
  if [ -z "$stripped" ]; then
    printf '0\n'
  else
    printf '%s\n' "$stripped"
  fi
}

# Test hook. Unset when this script runs as root. Records the owner and mode
# claim_one would have applied, so a reinstall can be checked without sudo.
stub_record() {
  local path="$1"
  local uid="$2"
  local gid="$3"
  local mode="$4"
  local norm
  norm=$(normalize_mode "$mode")
  mkdir -p "$OWNERSHIP_STUB"
  printf '%s\t%s\t%s\t%s\n' "$path" "$uid" "$gid" "$norm" >> "$OWNERSHIP_STUB/owners.tsv"
}

stub_lookup() {
  local path="$1"
  [ -f "$OWNERSHIP_STUB/owners.tsv" ] || return 0
  awk -F '\t' -v p="$path" '($1 == p) { uid = $2; gid = $3; mode = $4 } END { if (uid != "") printf "%s %s %s\n", uid, gid, mode }' "$OWNERSHIP_STUB/owners.tsv"
}

# Chown and chmod one existing path through a descriptor opened with
# O_NOFOLLOW, then read the result back. A symlink is refused. fchown does
# not follow a name swapped in after the check. A chown that does not stick
# is a failure: do not trust the file.
claim_one() {
  local path="$1"
  local uid="$2"
  local group="$3"
  local mode="$4"
  local uid_n gid_n
  if [ -L "$path" ]; then
    echo "refusing symlink $path" >&2
    exit 1
  fi
  if [ ! -e "$path" ]; then
    return 0
  fi
  uid_n=$(resolve_id "$uid")
  gid_n=$(resolve_gid "$group")
  if [ -z "$uid_n" ] || [ -z "$gid_n" ]; then
    echo "cannot resolve owner $uid:$group for $path" >&2
    exit 1
  fi
  if [ -n "$OWNERSHIP_STUB" ]; then
    chmod "$mode" "$path" || exit 1
    stub_record "$path" "$uid_n" "$gid_n" "$mode"
    assert_one "$path" "$uid" "$group" "$mode" 0
    return 0
  fi
  node -e '
    const fs = require("node:fs");
    const target = process.argv[1];
    const uid = Number(process.argv[2]);
    const gid = Number(process.argv[3]);
    const mode = Number.parseInt(process.argv[4], 8);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(target, flags | fs.constants.O_DIRECTORY);
    } catch (error) {
      if (!error || error.code !== "ENOTDIR") {
        console.error("cannot take ownership of " + target);
        process.exit(1);
      }
      try {
        fd = fs.openSync(target, flags);
      } catch {
        console.error("cannot take ownership of " + target);
        process.exit(1);
      }
    }
    try {
      fs.fchownSync(fd, uid, gid);
      fs.fchmodSync(fd, mode);
    } catch {
      console.error("cannot take ownership of " + target);
      process.exit(1);
    } finally {
      fs.closeSync(fd);
    }
  ' "$path" "$uid_n" "$gid_n" "$mode" || exit 1
  assert_one "$path" "$uid" "$group" "$mode" 0
}

# Stat only. Does not chown. Start uses this so a box-owned file is never
# promoted to root just by launching the signer.
assert_one() {
  local path="$1"
  local uid="$2"
  local group="$3"
  local mode="$4"
  local optional="$5"
  local actual_uid actual_gid actual_mode want_uid want_gid want_mode recorded
  if [ ! -e "$path" ]; then
    if [ "$optional" = 1 ]; then
      return 0
    fi
    echo "missing $path" >&2
    exit 1
  fi
  if [ -L "$path" ]; then
    echo "refusing symlink $path" >&2
    exit 1
  fi
  want_uid=$(resolve_id "$uid")
  want_gid=$(resolve_gid "$group")
  want_mode=$(normalize_mode "$mode")
  if [ -z "$want_uid" ] || [ -z "$want_gid" ]; then
    echo "cannot resolve owner $uid:$group for $path" >&2
    exit 1
  fi
  if [ -n "$OWNERSHIP_STUB" ]; then
    recorded=$(stub_lookup "$path")
    actual_uid=${recorded%% *}
    recorded=${recorded#* }
    actual_gid=${recorded%% *}
    actual_mode=${recorded#* }
  else
    actual_uid=$(stat -c %u "$path")
    actual_gid=$(stat -c %g "$path")
    actual_mode=$(normalize_mode "$(stat -c %a "$path")")
  fi
  if [ "$actual_uid" != "$want_uid" ] || [ "$actual_gid" != "$want_gid" ] || [ "$actual_mode" != "$want_mode" ]; then
    echo "refusing untrusted $path (owner $actual_uid:$actual_gid mode $actual_mode, expected $want_uid:$want_gid mode $want_mode)" >&2
    exit 1
  fi
}

claim_tree() {
  # uid, group, and both modes stay local to this call. claim_one used to
  # assign those same names in the global shell, so the root owner of
  # start.lock leaked into every later file, including audit.jsonl.
  local root="$1"
  local uid="$2"
  local group="$3"
  local dir_mode="$4"
  local file_mode="$5"
  local list entry base
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "missing directory $root" >&2
    exit 1
  fi
  claim_one "$root" "$uid" "$group" "$dir_mode"
  if [ -f "$root/start.lock" ] && [ ! -L "$root/start.lock" ]; then
    claim_one "$root/start.lock" root root 600
  fi
  if [ -f "$root/signer.pid" ] && [ ! -L "$root/signer.pid" ]; then
    claim_one "$root/signer.pid" root root 600
  fi
  list=$(mktemp)
  find "$root" -mindepth 1 -xdev -print > "$list"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ -L "$entry" ]; then
      echo "refusing symlink $entry" >&2
      rm -f "$list"
      exit 1
    fi
    base=${entry##*/}
    if [ -d "$entry" ]; then
      claim_one "$entry" "$uid" "$group" "$dir_mode"
    elif [ -f "$entry" ]; then
      if [ "$base" = "start.lock" ] || [ "$base" = "signer.pid" ]; then
        claim_one "$entry" root root 600
      else
        claim_one "$entry" "$uid" "$group" "$file_mode"
      fi
    else
      echo "refusing special file $entry" >&2
      rm -f "$list"
      exit 1
    fi
  done < "$list"
  rm -f "$list"
}

claim_durable_ownership() {
  if [ "$SKIP_ROOT" = 1 ] && [ -z "$OWNERSHIP_STUB" ]; then
    return 0
  fi
  claim_one "$DURABLE" root root 755
  claim_one "$DURABLE/bin" root root 755
  claim_one "$CONFIG_SRC" root root 644
  claim_one "$TOKEN_FILE" root "$SIGNER_GROUP" 640
  claim_one "$VERIFIER_PUB" root root 644
  claim_one "$TARBALL" root root 644
  claim_one "$DURABLE/bin/grok-bot-signer.sh" root root 755
  claim_tree "$STATE_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 700 600
  claim_tree "$LOG_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 700 600
}

assert_trusted_files() {
  if [ "$SKIP_ROOT" = 1 ] && [ -z "$OWNERSHIP_STUB" ]; then
    return 0
  fi
  assert_one "$CONFIG_SRC" root root 644 0
  assert_one "$CONFIG" root root 644 0
  assert_one "$TOKEN_FILE" root "$SIGNER_GROUP" 640 0
  assert_one "$VERIFIER_PUB" root root 644 1
  assert_one "$ETC/verifier.pub" root root 644 1
  assert_one "$ETC/token" root "$SIGNER_GROUP" 640 1
  assert_one "$STATE_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 700 0
  assert_one "$STATE" "$SIGNER_USER" "$SIGNER_GROUP" 700 0
  assert_one "$NONCE_FILE" "$SIGNER_USER" "$SIGNER_GROUP" 600 1
  assert_one "$AUDIT_FILE" "$SIGNER_USER" "$SIGNER_GROUP" 600 1
  if [ "$STATE" != "$STATE_SRC" ]; then
    assert_one "$STATE_SRC/nonces.json" "$SIGNER_USER" "$SIGNER_GROUP" 600 1
    assert_one "$STATE_SRC/audit.jsonl" "$SIGNER_USER" "$SIGNER_GROUP" 600 1
  fi
}

same_inode() {
  [ "$(stat -c %d:%i "$1")" = "$(stat -c %d:%i "$2")" ]
}

mount_bind() {
  src=$1
  dest=$2
  if [ "$src" = "$dest" ]; then
    return 0
  fi
  if [ -L "$src" ] || [ -L "$dest" ]; then
    echo "refusing to bind a symlink ($src -> $dest)" >&2
    exit 1
  fi
  if [ ! -d "$src" ] || [ ! -d "$dest" ]; then
    echo "bind mount needs directories $src and $dest" >&2
    exit 1
  fi
  if mountpoint -q "$dest"; then
    if ! same_inode "$src" "$dest"; then
      echo "$dest is already mounted from a different directory than $src" >&2
      exit 1
    fi
  else
    mount --bind "$src" "$dest" || {
      echo "cannot bind-mount $src onto $dest" >&2
      exit 1
    }
    if ! same_inode "$src" "$dest"; then
      echo "bind mount $src onto $dest did not take effect" >&2
      exit 1
    fi
  fi
  # A plain bind inherits the source flags. Remount so nosuid,nodev,noexec
  # stick even when the mount was already present.
  mount -o remount,bind,nosuid,nodev,noexec "$dest" || {
    echo "cannot remount $dest nosuid,nodev,noexec" >&2
    exit 1
  }
}

# Fail closed. findmnt --target reports the mount that covers dest.
require_bind_flags() {
  dest=$1
  if ! command -v findmnt >/dev/null 2>&1; then
    echo "findmnt is required to check $dest" >&2
    exit 1
  fi
  opts=$(findmnt -no OPTIONS --target "$dest" 2>/dev/null || true)
  for flag in nosuid nodev noexec; do
    case ",$opts," in
      *",$flag,"*) ;;
      *)
        echo "$dest bind mount is missing $flag" >&2
        exit 1
        ;;
    esac
  done
}

require_persistent_mounts() {
  if [ "$SKIP_ROOT" = 1 ]; then
    return 0
  fi
  if [ "$STATE" = "$STATE_SRC" ] && [ "$LOG_DIR" = "$LOG_SRC" ]; then
    return 0
  fi
  if ! mountpoint -q "$STATE" || ! same_inode "$STATE_SRC" "$STATE"; then
    echo "$STATE is not a bind mount of $STATE_SRC; run provision" >&2
    exit 1
  fi
  if ! mountpoint -q "$LOG_DIR" || ! same_inode "$LOG_SRC" "$LOG_DIR"; then
    echo "$LOG_DIR is not a bind mount of $LOG_SRC; run provision" >&2
    exit 1
  fi
  require_bind_flags "$STATE"
  require_bind_flags "$LOG_DIR"
}

assert_config_paths() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const durable = path.resolve(process.argv[2]);
    const state = path.resolve(process.argv[3]);
    const stateSrc = path.resolve(process.argv[4]);
    const etcDir = path.resolve(process.argv[5]);
    function under(resolved, root) {
      return resolved === root || resolved.startsWith(root + path.sep);
    }
    for (const key of ["nonceStorePath", "auditLogPath"]) {
      const value = cfg[key];
      if (typeof value !== "string") {
        console.error(key + " must be a path under the persistent state directory or its bind mount");
        process.exit(1);
      }
      const resolved = path.resolve(value);
      if (!under(resolved, state) && !under(resolved, stateSrc) && !under(resolved, durable)) {
        console.error(key + " must stay under the persistent state directory or its bind mount");
        process.exit(1);
      }
    }
    if (typeof cfg.verifierPublicKeyPath !== "string") {
      console.error("verifierPublicKeyPath must be a path under the /etc replica or the persistent directory");
      process.exit(1);
    }
    const verifier = path.resolve(cfg.verifierPublicKeyPath);
    if (!under(verifier, etcDir) && !under(verifier, durable)) {
      console.error("verifierPublicKeyPath must stay under the /etc replica or the persistent directory");
      process.exit(1);
    }
    if (cfg.trustAnchor !== undefined && cfg.trustAnchor !== "") {
      if (typeof cfg.trustAnchor !== "string" || !path.isAbsolute(cfg.trustAnchor)) {
        console.error("trustAnchor must be an absolute path");
        process.exit(1);
      }
      const anchor = path.resolve(cfg.trustAnchor);
      if (!under(anchor, durable) && anchor !== durable) {
        console.error("trustAnchor must be the persistent directory or a directory inside it");
        process.exit(1);
      }
      for (const key of ["nonceStorePath", "auditLogPath"]) {
        if (!under(path.resolve(cfg[key]), anchor)) {
          console.error(key + " must stay under trustAnchor");
          process.exit(1);
        }
      }
    }
  ' "$CONFIG_SRC" "$DURABLE" "$STATE" "$STATE_SRC" "$ETC"
}

write_config_template() {
  cat > "$CONFIG_SRC.tmp" <<EOF
{
  "chainId": 43114,
  "socketPath": "$SOCKET",
  "auditLogPath": "$AUDIT_FILE",
  "nonceStorePath": "$NONCE_FILE",
  "verifierPublicKeyPath": "$ETC/verifier.pub",
  "allow": {
    "43114": [
      { "address": "0x0000000000000000000000000000000000000001", "selectors": ["0x"], "roles": ["recipient"] }
    ]
  },
  "slippageCaps": {
    "stableBps": 50,
    "topBps": 200,
    "otherBps": 300,
    "stables": [
      "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"
    ],
    "top": [
      "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      "0x152b9d0FdC40C096757F570A51E494bd4b943E50",
      "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
      "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE"
    ]
  }
}
EOF
  chmod 0644 "$CONFIG_SRC.tmp"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$CONFIG_SRC.tmp"
  fi
  mv "$CONFIG_SRC.tmp" "$CONFIG_SRC"
}

require_tarball_digest() {
  digest=$1
  if ! printf '%s' "$digest" | grep -E -q '^[0-9a-f]{64}$'; then
    echo "tarball sha256 is required and must be 64 hex characters" >&2
    exit 1
  fi
}

# Copy into the root-owned ephemeral directory before hashing. The digest is
# compared to that copy, and that same copy is what npm ci installs.
stage_tarball() {
  src=$1
  if [ -L "$src" ] || [ ! -f "$src" ]; then
    echo "provision requires the pinned tarball at $src" >&2
    exit 1
  fi
  make_dir "$EPHEMERAL" root root 0755
  incoming=$STAGED_TARBALL.incoming
  rm -f "$incoming"
  cp -P "$src" "$incoming"
  if [ -L "$incoming" ] || [ ! -f "$incoming" ]; then
    echo "refusing to stage $src" >&2
    exit 1
  fi
  chmod 0644 "$incoming"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$incoming"
  fi
  mv -f "$incoming" "$STAGED_TARBALL"
  if [ -L "$STAGED_TARBALL" ] || [ ! -f "$STAGED_TARBALL" ]; then
    echo "refusing symlink $STAGED_TARBALL" >&2
    exit 1
  fi
}

# Record the node that installed the tarball. start runs that binary, not PATH.
pin_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to install the pinned tarball" >&2
    exit 1
  fi
  node_cmd=$(command -v node)
  node_real=$(readlink -f "$node_cmd" 2>/dev/null || true)
  if [ -z "$node_real" ]; then
    node_real=$node_cmd
  fi
  if [ -L "$node_real" ] || [ ! -x "$node_real" ]; then
    echo "pinned node is not executable" >&2
    exit 1
  fi
  printf '%s\n' "$node_real" > "$NODE_FILE"
  chmod 0644 "$NODE_FILE"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$NODE_FILE"
  fi
}

verify_staged_tarball() {
  digest=$1
  actual=$(sha256sum "$STAGED_TARBALL" | awk 'NR==1 { print $1 }')
  if [ "$actual" != "$digest" ]; then
    echo "tarball sha256 does not match" >&2
    exit 1
  fi
}

install_pinned_tarball() {
  if [ -L "$STAGED_TARBALL" ] || [ ! -f "$STAGED_TARBALL" ]; then
    echo "refusing to install $STAGED_TARBALL" >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install the pinned tarball" >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required to install the pinned tarball" >&2
    exit 1
  fi
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  tar -xzf "$STAGED_TARBALL" -C "$PREFIX" --strip-components=1
  if [ -L "$PREFIX/package.json" ] || [ -L "$PREFIX/npm-shrinkwrap.json" ]; then
    echo "refusing symlink in the extracted tarball" >&2
    exit 1
  fi
  if [ ! -f "$PREFIX/package.json" ] || [ ! -f "$PREFIX/npm-shrinkwrap.json" ]; then
    echo "tarball must contain package.json and npm-shrinkwrap.json" >&2
    exit 1
  fi
  npm ci --prefix "$PREFIX" --omit=dev --ignore-scripts
  # npm ci links dependency bins only. The package's own bin is not created.
  if [ -L "$BIN" ] || [ ! -f "$BIN" ]; then
    echo "missing $BIN" >&2
    exit 1
  fi
  pin_node
  if [ "$SKIP_ROOT" != 1 ]; then
    chown -R root:root "$PREFIX"
  fi
  chmod -R u+rwX,go+rX,go-w "$PREFIX"
  packaged=$PREFIX/scripts/grok-bot-signer.sh
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
  local src="$1"
  local dest="$2"
  local mode="$3"
  local group="$4"
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
  if [ -n "$OWNERSHIP_STUB" ]; then
    claim_one "$dest" root "$group" "$mode"
  fi
}

restore_etc() {
  make_dir "$ETC" root root 0755
  restore_etc_file "$CONFIG_SRC" "$ETC/config.json" 0644 root
  restore_etc_file "$VERIFIER_PUB" "$ETC/verifier.pub" 0644 root
  restore_etc_file "$TOKEN_FILE" "$ETC/token" 0640 "$SIGNER_GROUP"
  if [ "$SKIP_ROOT" = 1 ]; then
    return 0
  fi
  assert_one "$ETC/config.json" root root 644 1
  assert_one "$ETC/verifier.pub" root root 644 1
  assert_one "$ETC/token" root "$SIGNER_GROUP" 640 1
}

pin_verified_tarball() {
  if [ "$STAGED_TARBALL" = "$TARBALL" ]; then
    return 0
  fi
  if [ -L "$TARBALL" ]; then
    echo "refusing symlink $TARBALL" >&2
    exit 1
  fi
  make_dir "$(dirname "$TARBALL")" root root 0755
  cp -P "$STAGED_TARBALL" "$TARBALL.new"
  if [ -L "$TARBALL.new" ] || [ ! -f "$TARBALL.new" ]; then
    echo "refusing to pin $TARBALL" >&2
    exit 1
  fi
  chmod 0644 "$TARBALL.new"
  if [ "$SKIP_ROOT" != 1 ]; then
    chown root:root "$TARBALL.new"
  fi
  mv -f "$TARBALL.new" "$TARBALL"
}

# The approval private key is OPS_VERIFIER_ED25519 on the bot. The signer
# reads only verifier.pub. A key file on disk is refused.
refuse_verifier_private_key() {
  for path in "$DURABLE/verifier.key" "$ETC/verifier.key" "$VERIFIER_KEY"; do
    [ -n "$path" ] || continue
    if [ -e "$path" ] || [ -L "$path" ]; then
      echo "verifier private key must not live on disk ($path); remove it and set OPS_VERIFIER_ED25519" >&2
      exit 1
    fi
  done
}

# Default source when provision is given no tarball path. Root ignores
# EVALANCHE_BOX_TARBALL. A non-root run may use it as the source file only.
# The pin name still comes from the staged package.json.
default_tarball_source() {
  if [ "$(id -u)" -ne 0 ] && [ -n "${EVALANCHE_BOX_TARBALL:-}" ]; then
    printf '%s\n' "$EVALANCHE_BOX_TARBALL"
    return 0
  fi
  found=""
  count=0
  if [ -d "$DURABLE" ]; then
    for candidate in "$DURABLE"/evalanche-*.tgz; do
      [ -f "$candidate" ] || continue
      case "$candidate" in
        *\*) continue ;;
      esac
      count=$((count + 1))
      found=$candidate
    done
  fi
  if [ "$count" -eq 1 ]; then
    printf '%s\n' "$found"
    return 0
  fi
  if [ "$count" -gt 1 ]; then
    echo "provision needs one pinned tarball under $DURABLE" >&2
    return 1
  fi
  echo "provision requires a tarball path; the installed tree is not used" >&2
  return 1
}

# stdout is the version inside the staged tarball. The member must be a
# regular package/package.json. Errors go to stderr.
read_staged_version() {
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required to read the staged tarball version" >&2
    return 1
  fi
  meta=$(tar -tvzf "$STAGED_TARBALL" package/package.json 2>/dev/null) || {
    echo "staged tarball is missing package/package.json" >&2
    return 1
  }
  case "$meta" in
    l*)
      echo "refusing symlink package/package.json" >&2
      return 1
      ;;
  esac
  raw=$(tar -xOf "$STAGED_TARBALL" package/package.json | head -c 100001) || return 1
  printf '%s' "$raw" | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      if (raw.length > 100000) {
        console.error("package.json in the tarball is too large");
        process.exit(1);
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        console.error("package.json is not JSON");
        process.exit(1);
      }
      const version = parsed && parsed.version;
      if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
        console.error("package.json version is not a release version");
        process.exit(1);
      }
      process.stdout.write(version);
    });
  '
}

# The source basename evalanche-<version>.tgz must match the bytes.
assert_tarball_name_matches() {
  src=$1
  version=$2
  base=${src##*/}
  case "$base" in
    evalanche-*.tgz)
      named=${base#evalanche-}
      named=${named%.tgz}
      if [ "$named" != "$version" ]; then
        echo "tarball version $version does not match $base" >&2
        return 1
      fi
      ;;
  esac
  return 0
}

# Idempotent. Recreates the user, /opt, and /etc from the persistent directory.
# Does not generate a verifier key, rewrite the token, or reset nonce or audit files.
provision_signer() {
  src=${1:-}
  digest=${2:-}
  if [ -n "${3:-}" ]; then
    usage
  fi
  # Staged path does not depend on the version. The pin name is set after
  # the checksum, from package/package.json inside these bytes.
  STAGED_TARBALL=$EPHEMERAL/evalanche-staged.tgz
  if [ -z "$src" ]; then
    src=$(default_tarball_source) || exit 1
  fi
  require_root
  refuse_verifier_private_key
  if [ "$SKIP_ROOT" != 1 ]; then
    case "$DURABLE" in
      /home/*) ;;
      *)
        echo "durable signer state must live under /home" >&2
        exit 1
        ;;
    esac
  fi
  assert_state_path "nonce file" "$NONCE_FILE"
  assert_state_path "audit log" "$AUDIT_FILE"
  assert_under_durable "config source" "$CONFIG_SRC"
  assert_under_durable "state directory" "$STATE_SRC"
  assert_under_durable "log directory" "$LOG_SRC"
  assert_under_durable "token file" "$TOKEN_FILE"
  assert_under_durable "verifier pubkey" "$VERIFIER_PUB"
  case "$CONFIG" in
    "$ETC"/*|"$DURABLE"/*) ;;
    *)
      echo "signer config must be the /etc replica or a file under $DURABLE" >&2
      exit 1
      ;;
  esac
  require_tarball_digest "$digest"
  make_dir "$EPHEMERAL" root root 0755
  stage_tarball "$src"
  verify_staged_tarball "$digest"
  version=$(read_staged_version) || exit 1
  assert_tarball_name_matches "$src" "$version" || exit 1
  TARBALL=$DURABLE/evalanche-${version}.tgz
  assert_under_durable "pinned tarball" "$TARBALL"
  if [ -L "$CONFIG_SRC" ] || [ -L "$CONFIG" ] || [ -L "$STATE" ] || [ -L "$STATE_SRC" ] || [ -L "$LOG_SRC" ] || [ -L "$LOG_DIR" ] || [ -L "$DURABLE" ] || [ -L "$NONCE_FILE" ] || [ -L "$AUDIT_FILE" ] || [ -L "$ETC" ]; then
    echo "durable signer paths must not be symlinks" >&2
    exit 1
  fi
  ensure_signer_account
  make_dir "$DURABLE" root root 0755
  make_dir "$DURABLE/bin" root root 0755
  make_dir "$STATE_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$LOG_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$EPHEMERAL" root root 0755
  if [ "$STATE" != "$STATE_SRC" ]; then
    make_dir "$STATE" root root 0755
  fi
  if [ "$LOG_DIR" != "$LOG_SRC" ]; then
    make_dir "$LOG_DIR" root root 0755
  fi
  make_dir "$PREFIX" root root 0755
  make_dir "$SOCKET_DIR" "$SIGNER_USER" "$SIGNER_GROUP" 0750
  claim_durable_ownership
  if [ -f "$CONFIG_SRC" ]; then
    assert_config_paths
  else
    write_config_template
  fi
  pin_verified_tarball
  install_pinned_tarball
  restore_etc
  if [ "$SKIP_ROOT" != 1 ]; then
    mount_bind "$STATE_SRC" "$STATE"
    mount_bind "$LOG_SRC" "$LOG_DIR"
    require_persistent_mounts
  fi
  # Claim again so files written above (config, token, tarball, script) are
  # included. Owner and mode are per call, so the lock cannot leak onto them.
  claim_durable_ownership
  if [ "$SKIP_ROOT" != 1 ] || [ -n "$OWNERSHIP_STUB" ]; then
    assert_trusted_files
  fi
  echo "signer provisioned"
}

# escrow and restore are not used by provision or start.
assert_escrow_dir() {
  local dir="$1"
  case "$dir" in
    /*) ;;
    *)
      echo "escrow directory must be an absolute path" >&2
      exit 1
      ;;
  esac
  if [ "$SKIP_ROOT" != 1 ]; then
    case "$dir" in
      /home/*) ;;
      *)
        echo "escrow directory must live under /home" >&2
        exit 1
        ;;
    esac
  fi
  case "$dir" in
    "$DURABLE"|"$DURABLE"/*|"$STATE"|"$STATE"/*|"$STATE_SRC"|"$STATE_SRC"/*|"$ETC"|"$ETC"/*|"$PREFIX"|"$PREFIX"/*|"$EPHEMERAL"|"$EPHEMERAL"/*)
      echo "escrow directory must be outside the signer install" >&2
      exit 1
      ;;
  esac
}

copy_owned() {
  local src="$1"
  local dest="$2"
  local uid="$3"
  local group="$4"
  local mode="$5"
  if [ -L "$src" ] || [ ! -f "$src" ]; then
    echo "refusing to copy" >&2
    exit 1
  fi
  if [ -L "$dest" ]; then
    echo "refusing symlink" >&2
    exit 1
  fi
  rm -f "$dest"
  install -m "$mode" "$src" "$dest"
  claim_one "$dest" "$uid" "$group" "$mode"
}

write_escrow_manifest() {
  local dest="$1"
  shift
  node - "$dest" "$@" <<'END'
const fs = require('node:fs');
const crypto = require('node:crypto');
const dest = process.argv[2];
const files = [];
for (let i = 3; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const path = process.argv[i + 1];
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error('refusing escrow name');
    process.exit(1);
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  files.push({ name, sha256, mode: '600' });
}
files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
fs.writeFileSync(dest, JSON.stringify({ version: 1, files }) + '\n', { mode: 0o600 });
END
}

check_escrow_manifest() {
  local dir="$1"
  node - "$dir" <<'END'
const fs = require('node:fs');
const crypto = require('node:crypto');
const dir = process.argv[2];
const manifestPath = `${dir}/manifest.json`;
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  console.error('escrow manifest is unreadable');
  process.exit(1);
}
if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
  console.error('escrow manifest is invalid');
  process.exit(1);
}
const allowed = (name) => name === 'token'
  || name === 'nonces.json'
  || name === 'nonces.json.bak'
  || /^nonces\.json\.bak\.[0-9]{1,4}$/.test(name);
const seen = new Set();
for (const entry of manifest.files) {
  if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string' || entry.mode !== '600') {
    console.error('escrow manifest entry is invalid');
    process.exit(1);
  }
  if (!allowed(entry.name) || seen.has(entry.name) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    console.error('escrow manifest entry is invalid');
    process.exit(1);
  }
  const path = `${dir}/${entry.name}`;
  const info = fs.lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    console.error('refusing symlink in escrow');
    process.exit(1);
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  if (got !== entry.sha256) {
    console.error('escrow manifest hash mismatch');
    process.exit(1);
  }
  seen.add(entry.name);
}
if (!seen.has('token') || !seen.has('nonces.json')) {
  console.error('escrow manifest is missing required files');
  process.exit(1);
}
for (const name of fs.readdirSync(dir)) {
  if (name === 'manifest.json') continue;
  if (!seen.has(name)) {
    console.error('escrow directory has an unexpected file');
    process.exit(1);
  }
}
END
}

# Exit 0 when every current wallet and tx nonce is present and not lower.
nonce_restore_allowed() {
  local current="$1"
  local escrowed="$2"
  node - "$current" "$escrowed" <<'END'
const fs = require('node:fs');
const currentPath = process.argv[2];
const escrowPath = process.argv[3];
function load(path) {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    console.error('nonce file is not json');
    process.exit(3);
  }
}
function take(file, into) {
  if (!file || typeof file !== 'object') return;
  const wallets = file.wallets && typeof file.wallets === 'object' ? file.wallets : {};
  for (const [wallet, entry] of Object.entries(wallets)) {
    const last = entry && typeof entry.lastNonce === 'string' ? entry.lastNonce : '';
    into.set(`wallet:${wallet}`, last);
  }
  const tx = file.txNonces && typeof file.txNonces === 'object' ? file.txNonces : {};
  for (const [wallet, chains] of Object.entries(tx)) {
    if (!chains || typeof chains !== 'object') continue;
    for (const [chain, nonce] of Object.entries(chains)) {
      if (typeof nonce === 'string') into.set(`tx:${wallet}:${chain}`, nonce);
    }
  }
}
function order(left, right) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(left) || !/^-?(0|[1-9][0-9]*)$/.test(right)) return null;
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
const escrowed = load(escrowPath);
if (!escrowed) {
  console.error('escrow is missing the nonce file');
  process.exit(3);
}
const current = load(currentPath);
if (!current) process.exit(0);
const have = new Map();
const want = new Map();
take(current, have);
take(escrowed, want);
for (const [key, value] of have) {
  if (!want.has(key)) {
    console.error('refusing to restore a nonce high-water mark below the current one');
    process.exit(2);
  }
  const compared = order(want.get(key), value);
  if (compared === null) {
    console.error('nonce high-water mark is not a decimal string');
    process.exit(3);
  }
  if (compared < 0) {
    console.error('refusing to restore a nonce high-water mark below the current one');
    process.exit(2);
  }
}
END
}

backup_name_ok() {
  local name="$1"
  case "$name" in
    nonces.json.bak) return 0 ;;
    nonces.json.bak.[0-9]|nonces.json.bak.[0-9][0-9]|nonces.json.bak.[0-9][0-9][0-9]|nonces.json.bak.[0-9][0-9][0-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

escrow_signer() {
  local dir="${1:-}"
  local nonce_dir name list args bak count
  if [ -z "$dir" ] || [ -n "${2:-}" ]; then
    usage
  fi
  require_root
  refuse_verifier_private_key
  assert_escrow_dir "$dir"
  if [ "$(basename "$NONCE_FILE")" != nonces.json ]; then
    echo "nonce file must be named nonces.json" >&2
    exit 1
  fi
  if [ -L "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then
    echo "missing bearer token file" >&2
    exit 1
  fi
  if [ -L "$NONCE_FILE" ] || [ ! -f "$NONCE_FILE" ]; then
    echo "missing nonce file" >&2
    exit 1
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    echo "escrow path is not a directory" >&2
    exit 1
  fi
  if [ -L "$dir" ]; then
    echo "refusing symlink" >&2
    exit 1
  fi
  make_dir "$dir" "$BOX_USER" "$BOX_GROUP" 0700
  list=$(mktemp)
  nonce_dir=$(dirname "$NONCE_FILE")
  find "$nonce_dir" -maxdepth 1 -name 'nonces.json.bak*' -print > "$list"
  while IFS= read -r bak; do
    [ -n "$bak" ] || continue
    name=${bak##*/}
    if ! backup_name_ok "$name"; then
      echo "refusing unexpected nonce backup name" >&2
      rm -f "$list"
      exit 1
    fi
    if [ -L "$bak" ] || [ ! -f "$bak" ]; then
      echo "refusing symlink" >&2
      rm -f "$list"
      exit 1
    fi
  done < "$list"
  if [ -d "$dir" ]; then
    find "$dir" -mindepth 1 -maxdepth 1 -print | while IFS= read -r entry; do
      name=${entry##*/}
      case "$name" in
        manifest.json|token|nonces.json|nonces.json.bak|nonces.json.bak.[0-9]|nonces.json.bak.[0-9][0-9]|nonces.json.bak.[0-9][0-9][0-9]|nonces.json.bak.[0-9][0-9][0-9][0-9]) ;;
        *)
          echo "escrow directory has an unexpected file" >&2
          exit 1
          ;;
      esac
    done
  fi
  copy_owned "$TOKEN_FILE" "$dir/token" "$BOX_USER" "$BOX_GROUP" 600
  copy_owned "$NONCE_FILE" "$dir/nonces.json" "$BOX_USER" "$BOX_GROUP" 600
  count=2
  args="token $dir/token nonces.json $dir/nonces.json"
  while IFS= read -r bak; do
    [ -n "$bak" ] || continue
    name=${bak##*/}
    copy_owned "$bak" "$dir/$name" "$BOX_USER" "$BOX_GROUP" 600
    args="$args $name $dir/$name"
    count=$((count + 1))
  done < "$list"
  rm -f "$list"
  # shellcheck disable=SC2086
  write_escrow_manifest "$dir/manifest.json.new" $args
  mv -f "$dir/manifest.json.new" "$dir/manifest.json"
  claim_one "$dir/manifest.json" "$BOX_USER" "$BOX_GROUP" 600
  echo "escrowed signer state ($count files)"
}

restore_signer_dirs() {
  make_dir "$DURABLE" root root 0755
  make_dir "$DURABLE/bin" root root 0755
  make_dir "$STATE_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$LOG_SRC" "$SIGNER_USER" "$SIGNER_GROUP" 0700
  make_dir "$EPHEMERAL" root root 0755
  if [ "$STATE" != "$STATE_SRC" ]; then
    make_dir "$STATE" root root 0755
  fi
  if [ "$LOG_DIR" != "$LOG_SRC" ]; then
    make_dir "$LOG_DIR" root root 0755
  fi
  make_dir "$PREFIX" root root 0755
  make_dir "$SOCKET_DIR" "$SIGNER_USER" "$SIGNER_GROUP" 0750
  make_dir "$ETC" root root 0755
}

restore_signer() {
  local dir="${1:-}"
  local current name
  if [ -z "$dir" ] || [ -n "${2:-}" ]; then
    usage
  fi
  require_root
  refuse_verifier_private_key
  assert_escrow_dir "$dir"
  if [ ! -d "$dir" ] || [ -L "$dir" ]; then
    echo "escrow directory is missing" >&2
    exit 1
  fi
  check_escrow_manifest "$dir" || exit 1
  if [ -f "$STATE_SRC/nonces.json" ] && [ ! -L "$STATE_SRC/nonces.json" ]; then
    current=$STATE_SRC/nonces.json
  elif [ -f "$NONCE_FILE" ] && [ ! -L "$NONCE_FILE" ]; then
    current=$NONCE_FILE
  else
    current=""
  fi
  if [ -n "$current" ]; then
    nonce_restore_allowed "$current" "$dir/nonces.json" || exit 1
  else
    nonce_restore_allowed "$dir/.no-current-nonce" "$dir/nonces.json" || exit 1
  fi
  restore_signer_dirs
  copy_owned "$dir/token" "$TOKEN_FILE" root "$SIGNER_GROUP" 640
  copy_owned "$dir/nonces.json" "$STATE_SRC/nonces.json" "$SIGNER_USER" "$SIGNER_GROUP" 600
  if [ "$NONCE_FILE" != "$STATE_SRC/nonces.json" ]; then
    make_dir "$(dirname "$NONCE_FILE")" "$SIGNER_USER" "$SIGNER_GROUP" 0700
    copy_owned "$dir/nonces.json" "$NONCE_FILE" "$SIGNER_USER" "$SIGNER_GROUP" 600
  fi
  for name in "$dir"/nonces.json.bak "$dir"/nonces.json.bak.*; do
    [ -f "$name" ] || continue
    [ -L "$name" ] && { echo "refusing symlink" >&2; exit 1; }
    copy_owned "$name" "$STATE_SRC/${name##*/}" "$SIGNER_USER" "$SIGNER_GROUP" 600
    if [ "$NONCE_FILE" != "$STATE_SRC/nonces.json" ]; then
      copy_owned "$name" "$(dirname "$NONCE_FILE")/${name##*/}" "$SIGNER_USER" "$SIGNER_GROUP" 600
    fi
  done
  echo "restored signer state"
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) run_start 0 "$@" ;;
  init) run_start 1 "$@" ;;
  stop) stop_signer ;;
  health) health_signer ;;
  provision) provision_signer "$@" ;;
  escrow) escrow_signer "$@" ;;
  restore) restore_signer "$@" ;;
  *) usage ;;
esac
