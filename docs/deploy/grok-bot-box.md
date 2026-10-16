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

| Path | Owner | Mode | Contents |
| --- | --- | --- | --- |
| `/opt/evalanche-signer` | root | `0755` | Pinned `evalanche@1.15.0` install. Not under `/workspace`. |
| `/etc/evalanche-signer/config.json` | root | `0644` | Allow map, paths, chain id. No key and no bearer token. |
| `/etc/evalanche-signer/token` | root | `0640` | Bearer token. Group `evalanche-signer`. Not regenerated on start. |
| `/etc/evalanche-signer/verifier.key` | root | `0600` | Ed25519 approval private key. Generated on the box. Not an environment secret. |
| `/etc/evalanche-signer/verifier.pub` | root | `0644` | Ed25519 verifier public key. |
| `/var/lib/evalanche-signer/state/start.lock` | root | `0600` | flock held for the whole `start`. |
| `/var/lib/evalanche-signer` | root | `0755` | Parent of the state, log, and socket directories. |
| `/var/lib/evalanche-signer/state` | `evalanche-signer` | `0700` | Nonce file, audit JSONL, budget, lock, pid file. |
| `/var/lib/evalanche-signer/log` | `evalanche-signer` | `0700` | Process log. |
| `/var/lib/evalanche-signer/run` | `evalanche-signer` | `0750` | Unix socket directory. Group `evalanche-signer`. |
| `/var/lib/evalanche-signer/run/signer.sock` | `evalanche-signer` | `0660` | HTTP over a Unix socket. Created by the process. |

`/opt`, `/etc`, `/var`, and `/var/lib` are real directories on this host (not symlinks), root-owned, and not group- or world-writable. The Linux lock helper inside the package is opened from that root-owned tree.

Add `box` to the `evalanche-signer` group so both agents can connect to the socket and read the bearer token. `usermod -aG` does not change the groups of an agent that is already running. Restart both agents after the group change. The state and log directories stay mode `0700`, so the socket is the path the agents use.

## Install

Build the tarball on a machine that has this repository, then copy that one file to the box. Do not install from `/workspace` on the box.

```sh
npm pack
sha256sum evalanche-1.15.0.tgz
```

Record that digest with the release. On the box, as root:

```sh
id box
getent group sudo | grep -E '(^|:)box($|,)' || true
sudo -u box sudo -n true

install -d -o root -g root -m 0755 /opt/evalanche-signer /etc/evalanche-signer /var/lib/evalanche-signer
# Confirm the digest, then:
npm install --prefix /opt/evalanche-signer --omit=dev --ignore-scripts /path/to/evalanche-1.15.0.tgz
chown -R root:root /opt/evalanche-signer
chmod -R u+rwX,go+rX,go-w /opt/evalanche-signer
install -D -o root -g root -m 0755 \
  /opt/evalanche-signer/node_modules/evalanche/scripts/grok-bot-signer.sh \
  /opt/evalanche-signer/bin/grok-bot-signer.sh

if ! id evalanche-signer >/dev/null 2>&1; then
  groupadd --system evalanche-signer
  useradd --system --gid evalanche-signer --no-create-home --shell /bin/false evalanche-signer
fi
usermod -aG evalanche-signer box
# Restart both agents after this. A running process keeps its old groups.

install -d -o evalanche-signer -g evalanche-signer -m 0700 \
  /var/lib/evalanche-signer/state /var/lib/evalanche-signer/log
install -d -o evalanche-signer -g evalanche-signer -m 0750 /var/lib/evalanche-signer/run
```

`/opt/evalanche-signer/node_modules/.bin/evalanche-signer` is the binary. The package ships one `flock-linux-x64` helper. It is dynamically linked and needs glibc 2.34 or newer, which covers glibc 2.41.

`scripts/grok-bot-signer.sh` is in the published package `files` list, so the tarball contains it at `package/scripts/grok-bot-signer.sh` and the install above copies that file. The same path exists in the git tree. If the tarball is not on the box, fetch `scripts/grok-bot-signer.sh` from the git tag that matches the pinned tarball and `install -D` that copy instead. `npm install` does not put the script on `PATH`.

`--ignore-scripts` skips package lifecycle scripts. npm still links the `evalanche-signer` bin.

Generate the Ed25519 approval key on the box. The private key is written to `/etc/evalanche-signer/verifier.key` (root, mode `0600`). The public key is written to `/etc/evalanche-signer/verifier.pub` (root, mode `0644`). The key is not an environment secret and it is not placed on a command line. Run this as root from the install directory:

```sh
cd /opt/evalanche-signer
node --input-type=module <<'EOF'
import { writeFileSync } from 'node:fs';
import { generateEd25519KeyPair } from 'evalanche';
const pair = generateEd25519KeyPair();
writeFileSync('/etc/evalanche-signer/verifier.key', `${pair.privateKey}\n`, { mode: 0o600 });
writeFileSync('/etc/evalanche-signer/verifier.pub', `${pair.publicKey}\n`, { mode: 0o644 });
EOF
chown root:root /etc/evalanche-signer/verifier.key /etc/evalanche-signer/verifier.pub
chmod 0600 /etc/evalanche-signer/verifier.key
chmod 0644 /etc/evalanche-signer/verifier.pub
```

`/etc/evalanche-signer/config.json` (root, mode `0644`):

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

Create the bearer token once. The start script reads this file. It does not generate a new token:

```sh
openssl rand -hex 32 > /etc/evalanche-signer/token.new
chown root:evalanche-signer /etc/evalanche-signer/token.new
chmod 0640 /etc/evalanche-signer/token.new
mv /etc/evalanche-signer/token.new /etc/evalanche-signer/token
```

The file is root-owned, mode `0640`, group `evalanche-signer`. `box` can read it after the group change and an agent restart. Do not log the token and do not put it in `config.json`.

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

`start` holds an exclusive flock on `/var/lib/evalanche-signer/state/start.lock` for the whole launch, so a second start waits and then fails if a signer is already running. It records only the child it launched. That child is identified by an environment mark, not by the first signer pid on the host. `start` removes a stale socket, launches the signer with `setsid`, waits until that pid answers `GET /health` with status 200, and only then writes the pidfile. It stops waiting as soon as that child exits. `stop` checks `/proc/<pid>/cmdline` and the uid from `/proc/<pid>/status` before it signals the process. It does not kill an unverified pid. When the pidfile is missing, empty, stale, or a zombie, `stop` signals each verified signer pid and exits non-zero if any remain. `SIGTERM` and `SIGINT` halt the signer first, so every route returns 503 and no signature is produced, then close the server. When this script runs as root it ignores `EVALANCHE_BOX_*` overrides, including `EVALANCHE_BOX_SKIP_ROOT` and `EVALANCHE_BOX_BIN`, and uses the paths in the layout table.

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
EVALANCHE_SIGNER_TOKEN=$(tr -d '\n' < /etc/evalanche-signer/token)
export EVALANCHE_SIGNER_TOKEN
```

To rotate, replace the file as root, restart the signer, and have both agents re-read it. The previous token stops working when the new process is listening:

```sh
openssl rand -hex 32 > /etc/evalanche-signer/token.new
chown root:evalanche-signer /etc/evalanche-signer/token.new
chmod 0640 /etc/evalanche-signer/token.new
mv /etc/evalanche-signer/token.new /etc/evalanche-signer/token
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
  ['-n', 'cat', '/etc/evalanche-signer/verifier.key'],
  { encoding: 'utf8' },
).trim();
const verifierPublicKey = readFileSync('/etc/evalanche-signer/verifier.pub', 'utf8').trim();
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

`signVerifierApproval` signs `evalanche-verifier/v1`, the decision `approve`, the mode (`dry-run` or `live`), the signer address, the chain id, and the intent hash. The mode must match `/health`. The default above is `dry-run`. The approval step reads `/etc/evalanche-signer/verifier.key` with `sudo -n cat`. The path is the only argument. The key is not read from the environment and it is not passed in argv. The public key is the file `/etc/evalanche-signer/verifier.pub`. The proposer reads `/etc/evalanche-signer/token` into `EVALANCHE_SIGNER_TOKEN` before it calls the socket.

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
