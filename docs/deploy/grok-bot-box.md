# Grok Bot box

This release runs on one shared Linux x86_64 host with glibc 2.41. Two agents use it autonomously. Both agents are uid 1000, user `box`, with passwordless sudo. There is no Mac mini in this deploy.

The signer process is a different user, `evalanche-signer`. Its install, config, and verifier public key are root-owned. Its state and log directories are mode `0700`. On this box those permissions do not stop a malicious root-capable agent. TM-008 records that accepted risk (2026-10-16, Giacomo Barbieri): the signer enforces policy against mistakes, confused agents, and bad inputs. It is not a security boundary against root.

The wallet key is read only from `EVALANCHE_SIGNER_PRIVATE_KEY`. The verifier agent maps it from its own secret at launch:

```sh
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY"
```

The key is not written to disk, not placed in the config, and not logged. After the signer reads it, the process deletes `EVALANCHE_SIGNER_PRIVATE_KEY` from `process.env` before it starts the lock helper. It deletes `EVALANCHE_SIGNER_TOKEN` the same way. The start script passes the key with `sudo --preserve-env` so the value is not an argument in the process list. That delete does not remove the key from `/proc/<pid>/environ` of the launcher, and the key stays in the signer's initial environ for the life of the process. TM-008 records that accepted risk.

`start` is dry-run. Live mode is the explicit command `start --live`. A root config with `"dryRun": true` stays dry-run: the CLI ORs that field, and no flag can clear it.

## Layout

On this box `/etc`, `/opt`, and `/var` do not persist across a reset. Only `/home` does. A reset removes the `evalanche-signer` user, the install under `/opt`, the `/etc/evalanche-signer` replica, and `/var/lib/evalanche-signer`. The verifier key, bearer token, nonce store, audit log, config, and pinned tarball live in one root-only directory:

`/home/box/agent-data/evalanche-persist`

That path is the Grok Bot default. Every state path below is still configurable. When `grok-bot-signer.sh` runs as root it ignores `EVALANCHE_BOX_*` and uses the defaults in the table. A non-root run, which is how the tests call it, can override each path with the matching variable.

| Path | Owner | Mode | Survives reset | Contents |
| --- | --- | --- | --- | --- |
| `/home/box/agent-data/evalanche-persist` | root | `0755` | yes | Durable root. Not the signer's login home. |
| `.../config.json` | root | `0644` | yes | Allow map and paths. Source of truth. No key and no bearer token. |
| `.../token` | root | `0640` | yes | Bearer token. Group `evalanche-signer`. Not regenerated on start or provision. |
| `.../verifier.key` | root | `0600` | yes | Ed25519 approval private key. Generated once. `provision` never replaces it. |
| `.../verifier.pub` | root | `0644` | yes | Ed25519 verifier public key. `provision` never replaces it. |
| `.../evalanche-1.15.0.tgz` | root | `0644` | yes | Pinned tarball. `provision` with no arguments installs this file. |
| `.../state` | `evalanche-signer` | `0700` | yes | Nonce file, audit JSONL, budget, lock, pid file. |
| `.../state/nonces.json` | `evalanche-signer` | `0600` | yes | Nonce high-water mark. Not reset when the file already exists. |
| `.../state/audit.jsonl` | `evalanche-signer` | `0600` | yes | Audit chain. Not rewritten by `provision`. |
| `.../log` | `evalanche-signer` | `0700` | yes | Process log. Bind-mounted onto `/var/lib/evalanche-signer/log`. |
| `.../state/start.lock` | root | `0600` | yes | flock held for the whole `start`. |
| `.../bin/grok-bot-signer.sh` | root | `0755` | yes | Script copy used after `/opt` is wiped. |
| `/etc/evalanche-signer` | root | `0755` | no | Replica of config, verifier key, verifier pubkey, and token. The signer reads this config and this verifier pubkey. |
| `/opt/evalanche-signer` | root | `0755` | no | Pinned `evalanche@1.15.0` install. Recreated by `provision`. |
| `/var/lib/evalanche-signer` | root | `0755` | no | Parent of the bind mounts and the socket directory. |
| `/var/lib/evalanche-signer/state` | `evalanche-signer` | `0700` | no | Bind mount of `.../state`. The signer opens the nonce file and the audit log here. |
| `/var/lib/evalanche-signer/log` | `evalanche-signer` | `0700` | no | Bind mount of `.../log`. |
| `/var/lib/evalanche-signer/run` | `evalanche-signer` | `0750` | no | Unix socket directory. Group `evalanche-signer`. |
| `/var/lib/evalanche-signer/run/signer.sock` | `evalanche-signer` | `0660` | no | HTTP over a Unix socket. Created by the process. |

`...` is `/home/box/agent-data/evalanche-persist`. Edit the files there. `provision` copies config, `verifier.key`, `verifier.pub`, and `token` into `/etc/evalanche-signer` and does not write those copies back. It does not copy the nonce file or the audit log there. The signer reads `/etc/evalanche-signer/config.json`. That config points `nonceStorePath` and `auditLogPath` at the bind mount, and `verifierPublicKeyPath` at `/etc/evalanche-signer/verifier.pub`.

The user and group are recreated at uid `960` and gid `960`, so the nonce files still belong to the signer after the account comes back. The signer's login directory is `/var/lib/evalanche-signer`, which does not persist. Durable state is not that home. The Linux lock helper is opened from `/opt/evalanche-signer`. `/opt`, `/var`, and `/var/lib` must be real directories, root-owned, and not group- or world-writable. `provision` recreates the signer directories under them after a reset.

### Bind mounts

`/home/box` is the `box` user's home and is uid 1000. The signer walks every parent of a config or verifier file to `/` and requires each one to be root-owned. A path under `/home/box` fails that walk. `provision` does not change the owner of `/home/box` or `/home/box/agent-data`.

State and log are opened through bind mounts whose parents are root-owned:

```sh
mount --bind /home/box/agent-data/evalanche-persist/state /var/lib/evalanche-signer/state
mount --bind /home/box/agent-data/evalanche-persist/log /var/lib/evalanche-signer/log
```

`provision` creates those mounts. It refuses a mount point that is already mounted from a different directory. A reset drops the mounts with `/var`. The next `provision` creates them again. `start` refuses to launch when either mount is missing, so nonce writes cannot land on a directory that the reset will delete.

### Ownership after a reset

A reset restores the persistent tree as uid 1000, not root. Every `provision` chowns and chmods it again, then reads the owners back. Config, the verifier key, the verifier pubkey, the token, and the pinned tarball must come back as root, with modes `0644`, `0600`, `0644`, `0640`, and `0644`. The state and log directories must come back as `evalanche-signer` mode `0700`, and the nonce and audit files as that user mode `0600`. If `chown` or `chmod` fails, or the stat afterwards does not match, `provision` exits non-zero and does not report success. `start` checks the same owners and modes and does not chown. A box-owned key, nonce, or config is never used.

### Trust anchor

`trustAnchor` in the signer config is a root-owned directory where parent ownership checks for the nonce and audit paths stop. Directories above it may be owned by `box`. The anchor itself must be root-owned and not group- or world-writable. Every component from `/` to the file is opened without following a symlink, so `box` cannot replace a parent with a symlink to another root-owned directory. Config and the verifier pubkey are not covered by the anchor. They stay on the `/etc` replica, whose parents are root-owned all the way to `/`.

The bind-mount layout does not need `trustAnchor`. Set it only when `nonceStorePath` and `auditLogPath` stay under the persistent directory instead of the mount:

```json
"trustAnchor": "/home/box/agent-data/evalanche-persist"
```

### Configurable paths

Root ignores every `EVALANCHE_BOX_*` variable and uses these defaults:

| Setting | Default | Override when not root |
| --- | --- | --- |
| Durable directory | `/home/box/agent-data/evalanche-persist` | `EVALANCHE_BOX_DURABLE` |
| Config source | `$DURABLE/config.json` | `EVALANCHE_BOX_CONFIG_SRC` |
| Signer config | `$ETC/config.json` | `EVALANCHE_BOX_CONFIG` |
| Persistent state | `$DURABLE/state` | `EVALANCHE_BOX_STATE_SRC` |
| State bind mount | `$EPHEMERAL/state` | `EVALANCHE_BOX_STATE` |
| Persistent log | `$DURABLE/log` | `EVALANCHE_BOX_LOG_SRC` |
| Nonce file | `$STATE/nonces.json` | `EVALANCHE_BOX_NONCE` |
| Audit log | `$STATE/audit.jsonl` | `EVALANCHE_BOX_AUDIT` |
| Bearer token | `$DURABLE/token` | `EVALANCHE_BOX_TOKEN_FILE` |
| Verifier private key | `$DURABLE/verifier.key` | `EVALANCHE_BOX_VERIFIER_KEY` |
| Verifier public key | `$DURABLE/verifier.pub` | `EVALANCHE_BOX_VERIFIER_PUB` |
| Pinned tarball | `$DURABLE/evalanche-1.15.0.tgz` | `EVALANCHE_BOX_TARBALL` |
| `/etc` replica | `/etc/evalanche-signer` | `EVALANCHE_BOX_ETC` |
| Install prefix | `/opt/evalanche-signer` | `EVALANCHE_BOX_PREFIX` |
| Ephemeral root | `/var/lib/evalanche-signer` | `EVALANCHE_BOX_EPHEMERAL` |
| Log directory | `$EPHEMERAL/log` | `EVALANCHE_BOX_LOG_DIR` |
| Socket directory | `$EPHEMERAL/run` | `EVALANCHE_BOX_SOCKET_DIR` |
| Socket | `$SOCKET_DIR/signer.sock` | `EVALANCHE_BOX_SOCKET` |
| Pid file | `$STATE/signer.pid` | `EVALANCHE_BOX_PIDFILE` |
| Log file | `$LOG_DIR/signer.log` | `EVALANCHE_BOX_LOG` |
| Start lock | `$STATE/start.lock` | `EVALANCHE_BOX_LOCK` |
| Signer user | `evalanche-signer` | `EVALANCHE_BOX_USER` |
| Binary | `$PREFIX/node_modules/.bin/evalanche-signer` | `EVALANCHE_BOX_BIN` |

`provision` requires the config source, token, both verifier files, the pinned tarball, and the persistent state and log directories to stay under the durable directory. The nonce and audit paths in the config must stay under that state directory or under its bind mount. As root the durable directory must be under `/home`.

Add `box` to the `evalanche-signer` group so both agents can connect to the socket and read the bearer token. `usermod -aG` does not change the groups of an agent that is already running. Restart both agents after the group change. The state and log directories stay mode `0700`, so the socket is the path the agents use.

## Install

Build the tarball on a machine that has this repository, then copy that one file to the box. Do not install from `/workspace` on the box.

```sh
npm pack
sha256sum evalanche-1.15.0.tgz
```

Record that digest with the release or the CI pack artifact. On the box, pass that recorded digest. Do not hash the file you are about to install: a copy under `/home` can be replaced before `provision` reads it. `provision` copies the tarball into `/var/lib/evalanche-signer/evalanche-1.15.0.tgz`, which is root-owned, hashes that copy, and installs those same bytes. The sha256 argument is required. A digest that does not match fails before `npm` and before the pinned copy is replaced.

```sh
id box
getent group sudo | grep -E '(^|:)box($|,)' || true
sudo -u box sudo -n true

# EVALANCHE_TARBALL_SHA256 is the digest published with the release, not a hash of the local file.
sudo /workspace/scripts/grok-bot-signer.sh provision \
  /workspace/evalanche-1.15.0.tgz \
  "$EVALANCHE_TARBALL_SHA256"
```

`provision` creates group and user `evalanche-signer` at gid `960` and uid `960`, adds `box` to that group when the account exists, and installs the pinned tarball with `npm ci --prefix /opt/evalanche-signer --omit=dev --ignore-scripts`. The tarball carries `npm-shrinkwrap.json`, so ethers, viem, and `@nktkas/hyperliquid` reinstall at the locked versions. It refuses a uid or gid `960` that already belongs to a different name. Restart both agents after the group change. A running process keeps its old groups.

The same command writes `/home/box/agent-data/evalanche-persist/config.json` only when that file is missing. Replace the placeholder allow map before live trading. If the file already exists, `nonceStorePath` and `auditLogPath` must sit under the state bind mount or the persistent state directory, and `verifierPublicKeyPath` must sit under `/etc/evalanche-signer` or the persistent directory. A `trustAnchor` must be the persistent directory or a directory inside it, and the nonce and audit paths must sit under that anchor.

`/opt/evalanche-signer/node_modules/.bin/evalanche-signer` is the binary. The package ships one `flock-linux-x64` helper. It is dynamically linked and needs glibc 2.34 or newer, which covers glibc 2.41.

`scripts/grok-bot-signer.sh` and `npm-shrinkwrap.json` are in the published package `files` list. `provision` extracts the tarball at `/opt/evalanche-signer` and runs `npm ci`. It copies the script to `/opt/evalanche-signer/bin/grok-bot-signer.sh` and to `/home/box/agent-data/evalanche-persist/bin/grok-bot-signer.sh`. `npm ci` does not put the script on `PATH`. The copy under `/home` is the one that still exists after a reset.

`--ignore-scripts` skips package lifecycle scripts. npm still links the `evalanche-signer` bin.

Generate the Ed25519 approval key once, into the persistent directory. `provision` does not create or replace it. If `verifier.key` is missing, the `/etc` replica is left without a key. The private key is root, mode `0600`. The public key is root, mode `0644`. The key is not an environment secret and it is not placed on a command line. Run this as root after the first `provision`, from the install directory:

```sh
cd /opt/evalanche-signer
node --input-type=module <<'EOF'
import { writeFileSync } from 'node:fs';
import { generateEd25519KeyPair } from 'evalanche';
const pair = generateEd25519KeyPair();
writeFileSync('/home/box/agent-data/evalanche-persist/verifier.key', `${pair.privateKey}\n`, { mode: 0o600 });
writeFileSync('/home/box/agent-data/evalanche-persist/verifier.pub', `${pair.publicKey}\n`, { mode: 0o644 });
EOF
chown root:root /home/box/agent-data/evalanche-persist/verifier.key /home/box/agent-data/evalanche-persist/verifier.pub
chmod 0600 /home/box/agent-data/evalanche-persist/verifier.key
chmod 0644 /home/box/agent-data/evalanche-persist/verifier.pub
```

Run `provision` once more after writing the key so `/etc/evalanche-signer` receives the replica. Later resets do that copy again from the same files.

`/home/box/agent-data/evalanche-persist/config.json` (root, mode `0644`):

```json
{
  "chainId": 43114,
  "socketPath": "/var/lib/evalanche-signer/run/signer.sock",
  "auditLogPath": "/var/lib/evalanche-signer/state/audit.jsonl",
  "nonceStorePath": "/var/lib/evalanche-signer/state/nonces.json",
  "verifierPublicKeyPath": "/etc/evalanche-signer/verifier.pub",
  "allow": {
    "43114": [
      { "address": "0x0000000000000000000000000000000000000001", "selectors": ["0x"], "roles": ["recipient"] }
    ]
  }
}
```

Leave out `privateKey`, `keystorePath`, `token`, and `dryRun` unless dry-run must stay on even for `start --live`. Roles are additive: a native send needs `recipient`, and an address may carry `recipient` together with `dex`.

Create the bearer token once, in the persistent directory. The start script reads this file. It does not generate a new token:

```sh
openssl rand -hex 32 > /home/box/agent-data/evalanche-persist/token.new
chown root:evalanche-signer /home/box/agent-data/evalanche-persist/token.new
chmod 0640 /home/box/agent-data/evalanche-persist/token.new
mv /home/box/agent-data/evalanche-persist/token.new /home/box/agent-data/evalanche-persist/token
```

The file is root-owned, mode `0640`, group `evalanche-signer`. `box` can read it after the group change and an agent restart. Do not log the token and do not put it in `config.json`. `provision` does not rotate this file.

## After a reset

`/etc`, `/opt`, and `/var` are gone, and so is the `evalanche-signer` account. `/home/box/agent-data/evalanche-persist` still has the verifier key, token, nonce store, audit log, config, pinned tarball, and a copy of this script. Nonce persistence is mandatory: do not delete `state/nonces.json` and do not run `init` when that file is already present. `init` on an existing nonce file does not reset it, but it is the first-launch command, not the reset command.

There is no boot hook, cron job, or systemd unit. A scheduler change needs the owner's approval. Re-run `provision` by hand, then `start`. With no arguments, `provision` installs the tarball already stored in the persistent directory. It recreates the user, `/opt`, and `/etc`, chowns the persistent files back from uid 1000, and bind-mounts state and log. It does not regenerate the verifier key and it does not reset the nonce high-water mark or the audit chain. If it cannot make those owners and modes stick, it stops before it reports success, and `start` will not launch on the box-owned files.

```sh
sudo /home/box/agent-data/evalanche-persist/bin/grok-bot-signer.sh provision

EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY" \
  sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY \
  /home/box/agent-data/evalanche-persist/bin/grok-bot-signer.sh start
```

Use `start --live` only when live mode is intended. Do not generate a new verifier key. Do not replace the token unless you mean to rotate it. Restart both agents if `provision` had to add `box` to `evalanche-signer` again, then start them reading the same token and verifier files under `/home/box/agent-data/evalanche-persist`.

## Start, stop, health

This host is not assumed to have systemd. If `systemctl` is present, the script says so and still starts the process itself.

The nonce file is created only by `init`. `start` does not pass `--init-nonces`. The first launch is dry-run:

```sh
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY" \
  sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY \
  /opt/evalanche-signer/bin/grok-bot-signer.sh init
```

Later launches use `start`. That command is dry-run. Live mode is explicit:

```sh
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY" \
  sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY \
  /opt/evalanche-signer/bin/grok-bot-signer.sh start --live
```

`start` holds an exclusive flock on `/var/lib/evalanche-signer/state/start.lock` for the whole launch. That file is the bind mount of the persistent state directory, so the lock survives a reset and is reattached by `provision`., so a second start waits and then fails if a signer is already running. It records only the child it launched. That child is identified by an environment mark, not by the first signer pid on the host. `start` removes a stale socket, launches the signer with `setsid`, waits until that pid answers `GET /health` with status 200, and only then writes the pidfile. It stops waiting as soon as that child exits. `stop` checks `/proc/<pid>/cmdline` and the uid from `/proc/<pid>/status` before it signals the process. It does not kill an unverified pid. When the pidfile is missing, empty, stale, or a zombie, `stop` signals each verified signer pid and exits non-zero if any remain. `SIGTERM` and `SIGINT` halt the signer first, so every route returns 503 and no signature is produced, then close the server. When this script runs as root it ignores `EVALANCHE_BOX_*` overrides, including `EVALANCHE_BOX_SKIP_ROOT` and `EVALANCHE_BOX_BIN`, and uses the paths in the layout table.

The dry-run command is equivalent to running the binary as the signer user with `--dry-run`. The script reads the token file into `EVALANCHE_SIGNER_TOKEN` for that process:

```sh
sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN \
  -u evalanche-signer -- \
  /opt/evalanche-signer/node_modules/.bin/evalanche-signer \
  --config /etc/evalanche-signer/config.json \
  --socket /var/lib/evalanche-signer/run/signer.sock \
  --dry-run
```

Health and stop:

```sh
sudo /opt/evalanche-signer/bin/grok-bot-signer.sh health
sudo /opt/evalanche-signer/bin/grok-bot-signer.sh stop
```

Health is `GET /health` on the socket. A dry-run signer returns `{"ok":true,"mode":"dry-run"}`. A live signer returns `{"ok":true,"mode":"live"}`. It does not require the bearer token. If the config file sets `"dryRun": true`, health stays `dry-run` after `start --live`.

### Bearer token: proposer read and rotation

The proposer reads the same file. `box` must already be in `evalanche-signer`, which requires an agent restart after `usermod`:

```sh
EVALANCHE_SIGNER_TOKEN=$(tr -d '\n' < /home/box/agent-data/evalanche-persist/token)
export EVALANCHE_SIGNER_TOKEN
```

To rotate, replace the file as root, restart the signer, and have both agents re-read it. The previous token stops working when the new process is listening:

```sh
openssl rand -hex 32 > /home/box/agent-data/evalanche-persist/token.new
chown root:evalanche-signer /home/box/agent-data/evalanche-persist/token.new
chmod 0640 /home/box/agent-data/evalanche-persist/token.new
mv /home/box/agent-data/evalanche-persist/token.new /home/box/agent-data/evalanche-persist/token
sudo /opt/evalanche-signer/bin/grok-bot-signer.sh stop
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY" \
  sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY \
  /opt/evalanche-signer/bin/grok-bot-signer.sh start
```

That restart is dry-run. Use `start --live` only when the signer should sign. Do not print the new token.

## Socket flow

The proposer and the verifier are the two `box` agents. The proposer builds an intent. The verifier approves that intent with Ed25519. The proposer posts the intent and the approval to the Unix socket. The signer checks the approval, the allowlist and roles, caps, decode, nonce, and expiry, then signs. In dry-run week it does the same checks, consumes the nonce, and returns without a signature.

### Verifier: approve an intent

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { computeApprovedTxHash, signVerifierApproval } from 'evalanche';

const verifierPrivateKey = execFileSync(
  'sudo',
  ['-n', 'cat', '/home/box/agent-data/evalanche-persist/verifier.key'],
  { encoding: 'utf8' },
).trim();
const verifierPublicKey = readFileSync('/home/box/agent-data/evalanche-persist/verifier.pub', 'utf8').trim();
const wallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const mode = process.env.EVALANCHE_SIGNER_MODE === 'live' ? 'live' : 'dry-run';
const now = Date.now();
const tx = {
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  value: '1',
  data: '0x',
  chainId: 43114,
  nonce: '0',
  gasLimit: '100000',
  maxFeePerGas: '0',
  maxPriorityFeePerGas: '0',
  gasPrice: '25000000000',
  type: 0,
};
const intent = {
  version: '1',
  intentId: 'intent-1',
  nonce: '1',
  createdAt: now,
  expiresAt: now + 300_000,
  wallet,
  chainId: 43114,
  venue: 'avalanche',
  action: 'transfer',
  routeHash: computeApprovedTxHash(tx),
  tx,
  tokenIn: { address: '0x0000000000000000000000000000000000000000', symbol: 'AVAX', decimals: 18 },
  amountIn: '1',
};
const approval = signVerifierApproval({
  intent,
  verifierPrivateKey,
  verifierPublicKey,
  mode,
  signerAddress: wallet,
});
```

`signVerifierApproval` signs `evalanche-verifier/v1`, the decision `approve`, the mode (`dry-run` or `live`), the signer address, the chain id, and the intent hash. The mode must match `/health`. The default above is `dry-run`. The approval step reads `/home/box/agent-data/evalanche-persist/verifier.key` with `sudo -n cat`. The path is the only argument. The key is not read from the environment and it is not passed in argv. The public key is the file `/home/box/agent-data/evalanche-persist/verifier.pub`. The proposer reads `/home/box/agent-data/evalanche-persist/token` into `EVALANCHE_SIGNER_TOKEN` before it calls the socket. The `/etc` copies are a replica and disappear on reset.

### Proposer: submit the approved intent on the socket

```js
import { RemoteSignerClient } from 'evalanche';

const client = new RemoteSignerClient({
  socketPath: '/var/lib/evalanche-signer/run/signer.sock',
  address: intent.wallet,
  tokenEnv: 'EVALANCHE_SIGNER_TOKEN',
});
const result = await client.signTransaction({
  requestId: 'live-1',
  kind: 'transaction',
  chainId: intent.chainId,
  from: intent.wallet,
  to: intent.tx.to,
  value: intent.tx.value,
  data: intent.tx.data,
  gasLimit: intent.tx.gasLimit,
  gasPrice: intent.tx.gasPrice,
  maxFeePerGas: intent.tx.maxFeePerGas,
  maxPriorityFeePerGas: intent.tx.maxPriorityFeePerGas,
  nonce: Number(intent.tx.nonce),
  type: intent.tx.type,
  intent: 'native send',
  structuredIntent: intent,
  approval,
});
```

`intent` and `approval` are the objects the verifier produced. `signTransaction` posts them to `POST /v1/sign` on the socket with `Authorization: Bearer $EVALANCHE_SIGNER_TOKEN`. A live signer returns `signedTransaction`. An `Evalanche` agent can use the same socket with `signer: { socketPath, address, tokenEnv: 'EVALANCHE_SIGNER_TOKEN' }` and `setSigningContext({ intent, structuredIntent, approval })` before `send`. `send` takes a human-readable AVAX value and broadcasts the signed transaction.

## Li.Fi quotes

The proposer asks Li.Fi for a route before it builds an intent. Every quote and advanced-routes request sends `integrator=evalanche` and `fee=0`. Li.Fi can apply a fee configured for that integrator when `fee` is left off the request. A non-zero integrator fee inserts a FeeForwarder as the first swap step. The signer denies that step: the FeeForwarder address is not an allowlisted dex. `fee=0` keeps that step out of the route. There is no proposer option to turn the fee back on.

`EvalancheConfig.allowExchanges` is the default exchange allowlist. A quote or tool call can pass its own `allowExchanges` and that list replaces the config for that request. On this box the production signer allowlist only includes KyberSwap, so the proposer sets the same limit:

```js
import { Evalanche } from 'evalanche';

const wallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const agent = new Evalanche({
  address: wallet,
  signer: {
    socketPath: '/var/lib/evalanche-signer/run/signer.sock',
    address: wallet,
    tokenEnv: 'EVALANCHE_SIGNER_TOKEN',
  },
  allowExchanges: ['kyberswap'],
});
```

Same-chain and bridge quotes then send `allowExchanges=kyberswap`. Advanced routes send `options.exchanges.allow` of `['kyberswap']`. A route through another DEX is not returned, so it never reaches the signer. The MCP tools `get_bridge_quote`, `get_bridge_routes`, `bridge_tokens`, `lifi_swap_quote`, `lifi_swap`, and `lifi_compose` accept `allowExchanges`. When that argument is omitted, the config list is used.

## Li.Fi V3 slippage

A V3 swap with `minAmountOut` of zero is rejected. The intent may carry `quotedAmountOut`, the decimal bought amount from the Li.Fi quote, and `maxSlippageBps`. The signer requires `minOut >= quotedAmountOut * (10000 - bps) / 10000`, using integer division. `bps` is `maxSlippageBps` when the intent sets it, and the bought-token class cap otherwise. `maxSlippageBps` above that class cap is rejected. The class is `tokenOut`:

- stable, default 50 bps
- top, default 200 bps
- every other token, default 300 bps

Address lists default to empty, so an unlisted bought token uses the other cap until the signer config names it. The signer does not ship a hardcoded top-10. An address listed as both stable and top is a stable. `stableBps`, `topBps`, and `otherBps` are optional integers from 0 to 10000. On this box, name the Avalanche stables and the assets treated as top:

```json
"slippageCaps": {
  "stables": [
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
    "0xc7198437980c041c805A1EDcbA50c1Ce5db95118"
  ],
  "top": [
    "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    "0x152b9d0FdC40C096757F570A51E494bd4b943E50",
    "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB"
  ]
}
```

Those stables are native USDC, USDT, and USDC.e. The top list is WAVAX, BTC.b, and WETH.e. Change the lists in the signer config when the book changes. A V3 intent must set `quotedAmountOut` from the Li.Fi quote. The signer denies the swap when that field is missing. It also denies a quote that integer-divides to a zero token-unit floor, so a quote of 1 with minOut 1 does not sign. When `tokenCaps` names the bought token, `quotedAmountOut` must be within that cap.

## Kyber receivers inside a V3 leg

The production allowlist marks KyberSwap MetaAggregationRouterV2 `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` as `dex` and `spender`, with no selectors. A direct call to the router is denied. When a Li.Fi V3 leg's `callData` starts with Kyber `swap` (`0xe21fd0e9`), the signer decodes that payload. The source token must be the leg's sending asset and the destination token must be the leg's receiving asset. On every leg except the last, `dstReceiver` must be the Li.Fi diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`. On the last leg it must be that diamond or an address with the `recipient` role. Real Li.Fi routes set `dstReceiver` to the diamond, including the last hop. A `0xe21fd0e9` payload that does not decode is denied. Other inner selectors are not Kyber and stay on the existing leg checks.

## Allowance reset

`approve(spender, 0)` for an allowlisted token and an allowlisted spender is accepted. A failed swap can clear the allowance it left behind. Unlimited approvals stay denied.

The signer does not require the approve and the swap in one request, and it does not deny an approve whose spender also has the `dex` role. Approve and swap are separate transactions. Requiring both in one signing request would reject the normal two-step flow and would also reject a later reset. The wallet approves the Li.Fi diamond, which is the top-level spender. Kyber's `spender` role is what lets a decoded leg name the router as `approveTo`. Roles are additive, so an address can be `dex` and `spender` together. Denying that combination would reject the Kyber router and would block an allowance reset to the same spender.

### Dry-run week

`grok-bot-signer.sh start` is dry-run. The verifier signs `mode: 'dry-run'`. The signer answers `{"requestId":"...","dryRun":true,"decision":"allow"}` and does not return a signed transaction. The SDK client treats a missing signature as a rejection, so the dry-run check is a direct socket call:

```js
import http from 'node:http';

const body = JSON.stringify({
  requestId: 'dry-1',
  kind: 'transaction',
  chainId: intent.chainId,
  from: intent.wallet,
  to: intent.tx.to,
  value: intent.tx.value,
  data: intent.tx.data,
  gasLimit: intent.tx.gasLimit,
  gasPrice: intent.tx.gasPrice,
  maxFeePerGas: intent.tx.maxFeePerGas,
  maxPriorityFeePerGas: intent.tx.maxPriorityFeePerGas,
  nonce: Number(intent.tx.nonce),
  type: intent.tx.type,
  intent: 'native send',
  structuredIntent: intent,
  approval,
});
const text = await new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/var/lib/evalanche-signer/run/signer.sock',
    path: '/v1/sign',
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.EVALANCHE_SIGNER_TOKEN}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  req.on('error', reject);
  req.end(body);
});
const result = JSON.parse(text);
if (!result.dryRun || result.decision !== 'allow') {
  throw new Error(text);
}
```

A live signer rejects a dry-run approval, and a dry-run signer rejects a live approval. When the dry-run week ends, stop the process and start it again with `start --live`. The verifier then signs `mode: 'live'`. A config file with `"dryRun": true` stays dry-run.
