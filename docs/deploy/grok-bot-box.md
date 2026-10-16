# Grok Bot box

This release runs on one shared Linux x86_64 host with glibc 2.41. Two agents use it autonomously. Both agents are uid 1000, user `box`, with passwordless sudo. There is no Mac mini in this deploy.

The signer process is a different user, `evalanche-signer`. Its install, config, and verifier public key are root-owned. Its state and log directories are mode `0700`. On this box those permissions do not stop a malicious root-capable agent. TM-008 records that accepted risk (2026-10-16, Giacomo Barbieri): the signer enforces policy against mistakes, confused agents, and bad inputs. It is not a security boundary against root.

The wallet key is read only from `EVALANCHE_SIGNER_PRIVATE_KEY`. The verifier agent maps it from its own secret at launch:

```sh
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY"
```

The key is not written to disk, not placed in the config, and not logged. After the signer reads it, the process deletes `EVALANCHE_SIGNER_PRIVATE_KEY` from `process.env` before it starts the lock helper. The start script passes the variable with `sudo --preserve-env` so the value is not an argument in the process list.

## Layout

| Path | Owner | Mode | Contents |
| --- | --- | --- | --- |
| `/opt/evalanche-signer` | root | `0755` | Pinned `evalanche@1.15.0` install. Not under `/workspace`. |
| `/etc/evalanche-signer/config.json` | root | `0644` | Allow map, paths, chain id. No key and no bearer token. |
| `/etc/evalanche-signer/verifier.pub` | root | `0644` | Ed25519 verifier public key. |
| `/var/lib/evalanche-signer` | root | `0755` | Parent of the state, log, and socket directories. |
| `/var/lib/evalanche-signer/state` | `evalanche-signer` | `0700` | Nonce file, audit JSONL, budget, lock, pid file. |
| `/var/lib/evalanche-signer/log` | `evalanche-signer` | `0700` | Process log. |
| `/var/lib/evalanche-signer/run` | `evalanche-signer` | `0750` | Unix socket directory. Group `evalanche-signer`. |
| `/var/lib/evalanche-signer/run/signer.sock` | `evalanche-signer` | `0660` | HTTP over a Unix socket. Created by the process. |

`/opt`, `/etc`, `/var`, and `/var/lib` are real directories on this host (not symlinks), root-owned, and not group- or world-writable. The Linux lock helper inside the package is opened from that root-owned tree.

Add `box` to the `evalanche-signer` group so both agents can connect to the socket. The state and log directories stay mode `0700`, so the socket is the path the agents use.

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
npm install --prefix /opt/evalanche-signer --omit=dev /path/to/evalanche-1.15.0.tgz
chown -R root:root /opt/evalanche-signer
chmod -R u+rwX,go+rX,go-w /opt/evalanche-signer
install -o root -g root -m 0755 scripts/grok-bot-signer.sh /opt/evalanche-signer/bin/grok-bot-signer.sh

if ! id evalanche-signer >/dev/null 2>&1; then
  groupadd --system evalanche-signer
  useradd --system --gid evalanche-signer --no-create-home --shell /bin/false evalanche-signer
fi
usermod -aG evalanche-signer box

install -d -o evalanche-signer -g evalanche-signer -m 0700 \
  /var/lib/evalanche-signer/state /var/lib/evalanche-signer/log
install -d -o evalanche-signer -g evalanche-signer -m 0750 /var/lib/evalanche-signer/run
```

`/opt/evalanche-signer/node_modules/.bin/evalanche-signer` is the binary. The package ships one `flock-linux-x64` helper. It is dynamically linked and needs glibc 2.34 or newer, which covers glibc 2.41.

Write the verifier public key, and only the public key, to `/etc/evalanche-signer/verifier.pub` (root, mode `0644`). Keep the Ed25519 private key in the verifier agent.

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

Leave out `privateKey`, `keystorePath`, and `token`. Roles are additive: a native send needs `recipient`, and an address may carry `recipient` together with `dex`.

## Start, stop, health

This host is not assumed to have systemd. If `systemctl` is present, the script says so and still starts the process itself.

The verifier agent launches the signer. It maps the wallet secret and does not write it to a file:

```sh
EVALANCHE_SIGNER_PRIVATE_KEY="$MONY_WALLET_PRIVATE_KEY" \
EVALANCHE_SIGNER_TOKEN="$(openssl rand -hex 32)" \
  sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN \
  /opt/evalanche-signer/bin/grok-bot-signer.sh start
```

The same command with `start --dry-run` is the dry-run week. The first start adds `--init-nonces` when the nonce file is absent. Later starts leave the nonce file in place.

The script is equivalent to running the binary as the signer user with the key in the environment:

```sh
sudo --preserve-env=EVALANCHE_SIGNER_PRIVATE_KEY,EVALANCHE_SIGNER_TOKEN \
  -u evalanche-signer -- \
  /opt/evalanche-signer/node_modules/.bin/evalanche-signer \
  --config /etc/evalanche-signer/config.json \
  --socket /var/lib/evalanche-signer/run/signer.sock
```

Health and stop:

```sh
sudo /opt/evalanche-signer/bin/grok-bot-signer.sh health
sudo /opt/evalanche-signer/bin/grok-bot-signer.sh stop
```

Health is `GET /health` on the socket and returns `{"ok":true}`. It does not require the bearer token.

## Socket flow

The proposer and the verifier are the two `box` agents. The proposer builds an intent. The verifier approves that intent with Ed25519. The proposer posts the intent and the approval to the Unix socket. The signer checks the approval, the allowlist and roles, caps, decode, nonce, and expiry, then signs. In dry-run week it does the same checks, consumes the nonce, and returns without a signature.

### Verifier: approve an intent

```js
import { computeApprovedTxHash, signVerifierApproval } from 'evalanche';

const wallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const mode = process.env.EVALANCHE_SIGNER_MODE === 'dry-run' ? 'dry-run' : 'live';
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
  verifierPrivateKey: process.env.EVALANCHE_VERIFIER_PRIVATE_KEY,
  verifierPublicKey: process.env.EVALANCHE_VERIFIER_PUBLIC_KEY,
  mode,
  signerAddress: wallet,
});
```

`signVerifierApproval` signs `evalanche-verifier/v1`, the decision `approve`, the mode (`dry-run` or `live`), the signer address, the chain id, and the intent hash. The mode must match the running signer. The public key must be the one in `/etc/evalanche-signer/verifier.pub`.

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

### Dry-run week

Start with `grok-bot-signer.sh start --dry-run`. The verifier signs `mode: 'dry-run'`. The signer answers `{"requestId":"...","dryRun":true,"decision":"allow"}` and does not return a signed transaction. The SDK client treats a missing signature as a rejection, so the dry-run check is a direct socket call:

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

A live signer rejects a dry-run approval, and a dry-run signer rejects a live approval. When the dry-run week ends, stop the process and start it again without `--dry-run`. The verifier then signs `mode: 'live'`.
