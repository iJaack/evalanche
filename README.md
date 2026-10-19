# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.17.0-rc.4](docs/releases/RELEASE_NOTES_1.17.0-rc.4.md)
- Published package: `evalanche@1.17.0-rc.4`
- Current package surface:
  - Provision `evalanche-1.17.0-rc.4.tgz` as a new pin. The live box is 1.17.0-rc.2 at `a55e307`. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, and `evalanche-1.17.0-rc.3.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
  - Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
  - Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.4.tgz`. `start` does not need package.json.
  - Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- Docs:
  - [Release notes](docs/releases/README.md)
  - [Roadmap](ROADMAP.md)
  - [Release process](RELEASING.md)
  - [Security](SECURITY.md)
<!-- GENERATED:release-summary:end -->

## Install

```bash
npm install evalanche
```

Avalanche remains the default network. Native X/P/C operations use `@avalanche-sdk/client`; the legacy Core wallet tree and dYdX support, exports and tools are removed. Hyperliquid perpetuals remain. v1.15.0 can run the agent with no private key in-process; v1.14.0 requires Node.js 20 or newer. Review both release notes before upgrading.

Fresh consumer installs require zero high/critical findings without consumer overrides. `@scure/bip32@1.7.0` is declared directly because `@avalanche-sdk/client@0.1.3` imports it at runtime without declaring it in its own package manifest.

### Avalanche L1s

Discover the current public mainnet or Fuji EVM L1 catalog, then verify a selected RPC before creating a wallet on it:

```typescript
import { Evalanche, listAvalancheL1s, getAvalancheL1Network } from 'evalanche';
const l1s = await listAvalancheL1s(); // { network: 'fuji', apiKey?: '...' } also supported
const network = await getAvalancheL1Network(4337); // Beam; checks eth_chainId
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY!, network });
console.log(agent.getChainInfo()); // BEAM native token, not AVAX
```

The [official live catalog](https://build.avax.network/docs/api-reference/data-api/evm-chains/supportedChains) supplies native token, blockchain ID, subnet ID and RPC metadata. These helpers support public EVM L1s with 18-decimal native tokens; custom EVM networks can still be supplied directly. They do not imply bridge, staking, identity registry or non-EVM support on every L1. X/P-chain signing remains scoped to C-Chain/Fuji. `switchNetwork` preserves spending limits and recorded wallet budgets.

Polymarket authenticated actions use the official `polymarket` CLI. Install it on production agents and keep it on a pinned path, or set `EVALANCHE_POLYMARKET_CLI_BIN=/absolute/path/to/polymarket`. Evalanche passes signer material through `POLYMARKET_PRIVATE_KEY` in the child process environment and never through CLI argv.

## Quick Start

```typescript
import { Evalanche } from 'evalanche';

const { agent } = await Evalanche.boot({ network: 'avalanche' });

console.log(agent.address);

const holdings = await agent.holdings().scan();
console.log(holdings.summary);
```

```ts
const { agent: robinhoodAgent } = await Evalanche.boot({ network: 'robinhood' });
console.log(robinhoodAgent.getChainInfo()); // Robinhood Chain, chain ID 4663
```

Robinhood's public RPC is rate-limited. For production, set `ROBINHOOD_RPC_URLS` or `EVALANCHE_ROBINHOOD_RPC_URLS` to a comma-separated list of provider endpoints. LI.FI bridging is supported when a live route is available; Gas.zip does not currently advertise Robinhood Chain support.

## MCP

```bash
npx evalanche-mcp
```

Evalanche ships an MCP server for wallet actions, holdings discovery, DeFi, bridge and swap flows, Polymarket, and perpetual venues.
The default MCP transport is stdio. HTTP mode is available for local automation, but requires an explicit bearer token:

```bash
EVALANCHE_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" npx evalanche-mcp --http --port 3402
```

## Remote signer

Use this when the agent shares a machine with other processes that can read its environment. Evalanche sends a canonical signing request. A separate `evalanche-signer` process holds the key and signs only after an Ed25519 approval from a pinned verifier.

```typescript
import { Evalanche, canonicalIntentJson, computeIntentHash, computeRouteHash } from 'evalanche';

const agent = new Evalanche({
  network: 'avalanche',
  signer: {
    url: process.env.EVALANCHE_SIGNER_URL!, // http://127.0.0.1:7410
    address: process.env.EVALANCHE_SIGNER_ADDRESS!,
    tokenEnv: 'EVALANCHE_SIGNER_TOKEN',
  },
});

// Read-only, no signer and no key:
const watcher = new Evalanche({ address: agent.address, network: 'avalanche' });
```

`privateKey`, `mnemonic`, and `signer` are mutually exclusive. Build a version `"1"` intent with `canonicalIntentJson` and hash it with `computeIntentHash`. Put the exact transaction in `intent.tx` (`to`, `value`, `data`, `chainId`, `nonce`, `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, `gasPrice`, `type`) and set `routeHash` to `computeApprovedTxHash`. Money and the approval nonce are decimal strings. The verifier signs `signVerifierApproval`, which covers `evalanche-verifier/v1`, the decision, `dry-run` or `live`, the signer address, the chain id, and the intent hash. Only `decision: "approve"` verifies. Swap and bridge intents must set `minAmountOut`. Attach the approval with `agent.setSigningContext({ intent, structuredIntent, approval })` before `send`, `signMessage`, or a venue call.

The Grok Bot box install, Unix socket flow, and dry-run week are in `docs/deploy/grok-bot-box.md`. On that host the signer reads the wallet key only from `EVALANCHE_SIGNER_PRIVATE_KEY` (the verifier agent maps it from `MONY_WALLET_PRIVATE_KEY`) and the bearer token from `EVALANCHE_SIGNER_TOKEN`, then removes both variables from `process.env`. The box start script defaults to dry-run.

```bash
export EVALANCHE_SIGNER_TOKEN="$(openssl rand -hex 32)"
export EVALANCHE_SIGNER_PRIVATE_KEY="0x..."
npx evalanche-signer --config signer.json --init-nonces
# dry-run verifies policy and approval, consumes the nonce, then returns without a signature
npx evalanche-signer --config signer.json --init-nonces --dry-run
```

The signer listens on `127.0.0.1` or `--socket`. The socket directory must be mode `0750`, owned by the signer user, and the socket is mode `0660`. It rejects a non-loopback bind unless configured otherwise. Config, keystore, and verifier pubkey files are opened with `O_NOFOLLOW` and must be root-owned and not group- or world-writable. Every parent of those files, and every parent of the state directories, must be root-owned, not group- or world-writable, and not a symlink. Nonce, audit, budget, and lock directories are owned by the signer user (`uid` equal to the process euid) and mode `0700`. `--allow-insecure-file-permissions` is for tests only. A verifier public key file is read from that same descriptor and pinned. Small-order keys, including the identity point, are rejected.

On macOS, `/tmp`, `/var`, and `/etc` are symlinks into `/private`, so the signer refuses them. Use a real directory such as `/Library/Application Support/evalanche-signer` (root, mode `0755`) for the config, keystore, and verifier key (root, mode `0644`). Put nonce, audit, and budget files in `/Library/Application Support/evalanche-signer/state` (signer user, mode `0700`). The same split works on Linux: `/etc/evalanche-signer` for the root-owned files and `/var/lib/evalanche-signer` for state, with no symlink in either path. On the Grok Bot box a reset wipes `/etc`, `/opt`, and `/var` and restores `/home` as uid 1000. `grok-bot-signer.sh provision` keeps the nonce store, audit log, verifier key, token, and config under `/home/box/agent-data/evalanche-persist`, chowns that tree back, bind-mounts state and log onto `/var/lib/evalanche-signer`, and recreates `/opt` and `/etc` without resetting nonces. It fails closed if a key, nonce, or config file is still owned by uid 1000.

Before it signs, the signer checks the pinned verifier key and accepts only an `approve` decision for the process mode. It matches every transaction field to `intent.tx`, decodes known calldata (ERC-20 transfer and approve, ERC-4626 deposit and redeem, Benqi submit and delayed redeem, Li.Fi `swapTokensGeneric`, the Avalanche V3 selectors `swapTokensSingleV3ERC20ToERC20` and `swapTokensMultipleV3ERC20ToERC20`, and `multicall`), and denies unknown selectors. Inner multicall selectors are allowlisted too. Allow entries carry roles, and roles are additive: one address may be both `dex` and `recipient`. `dex` is required for `callTo`, `spender` for `approveTo` and approve spenders, `recipient` for an ERC-20 transfer recipient, a native send, and a Li.Fi V3 receiver, `token` for an asset, and `vault` for deposit and redeem. A V3 receiver must have that role and must be the signer wallet. A V3 `minAmountOut` of zero is rejected. When the intent carries `quotedAmountOut`, that minOut must cover the quote after slippage, using `maxSlippageBps` or the bought-token class cap (stables 50 bps, top assets 200 bps, other tokens 300 bps). A Kyber `swap` (`0xe21fd0e9`) inside a V3 leg is decoded. Its destination receiver must be the Li.Fi diamond on an intermediate leg, or the diamond or an allowlisted recipient on the last leg. An approve of zero to an allowlisted spender is accepted. A token address is never accepted as `callTo`. The first Li.Fi leg must set `requiresDeposit`, and every later leg must not. A swap's first leg must match `tokenIn` and `amountIn`, the legs must chain, and the last receiving asset must match `tokenOut`. Caps price that sold asset, or a vault's configured underlying, and native value is counted once. A non-empty `allow` map is required. Benqi sAVAX instant unstake and Polymarket contracts cannot be allowlisted back on. Hyperliquid and Polymarket typed data are denied from the payload. Message and typed-data signing are off unless allowlisted. Permit, Permit2, and `increaseAllowance` stay off unless `explicitAllows` names them, and an opted-in permit still checks owner and spender. The nonce file must already exist unless `--init-nonces` is passed. The lock is an exclusive kernel lock. macOS uses `O_EXLOCK` (`0x20`) with `O_NONBLOCK` and `O_NOFOLLOW` on a descriptor this process keeps open. Linux opens the one sha256-pinned helper (`dist/helpers/flock-linux-x64`) with `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, hashes that descriptor, and execs `/proc/self/fd/N` without opening the path again. The helper file and every parent directory must be root-owned, not group- or world-writable, and not a symlink. If the helper exits after it has reported the lock, the signer stops accepting and signing and exits non-zero. The signer does not compile code or search `PATH` or the process cwd at startup. Rebuild that binary with `docker/flock-helper.Dockerfile` (Ubuntu 24.04 pinned by digest, GCC 13.3.0, the flags in `scripts/build-flock-helper.sh`). The binary is dynamically linked to glibc and runs on glibc 2.41. CI fails when the rebuilt sha256 differs from `LINUX_HELPER_SHA256`. Dry-run consumes the nonce. `tx.type` must be 0 or 2. The default gas-cost cap is about 0.02 native tokens, and it cannot be raised above 1. SpendingPolicy hourly and daily budgets are recorded after a live signature and restored on restart. Prices are by token address, HTTPS only, and fail closed. `/health` returns `{ "ok": true, "mode": "dry-run" }` or `{ "ok": true, "mode": "live" }`. Decisions are appended to a JSONL audit log whose `prevHash` chain starts at the SHA-256 of `evalanche-audit-root/v1`.

A config with a `chains` object is per chain. 43114 is on unless that entry sets `enabled: false` or `killSwitch: true`. The other eighteen mainnets stay off until `enabled: true`. Testnets are refused. A file with no `chains` object keeps the previous single-chain behaviour. Polymarket on Polygon and the Avalanche Uniswap v3 LP module are build-only and off until their own `enabled` flags are set. Direct swap venues for Cronos, Gnosis, Celo, and Mantle stay off until `dex.enabled`, and an enabled venue requires a pool allowlist plus a quote. Mantle stays off because its best pool is about $14k. Sonic and HyperEVM use the Kyber plus Li.Fi path and stay off until `enabled`. Moonbeam, Blast, and Scroll have no signer venue. Fantom and zkSync Era are not in the registry. The shape, the FOK limit, the position rules, and the per-chain venue assessment are in `docs/signer-multichain.md`.

`evalanche-mcp` can start keyless:

```bash
EVALANCHE_SIGNER_URL=http://127.0.0.1:7410 \
EVALANCHE_SIGNER_ADDRESS=0x... \
EVALANCHE_SIGNER_TOKEN=... \
npx evalanche-mcp --signer-url "$EVALANCHE_SIGNER_URL" --signer-address "$EVALANCHE_SIGNER_ADDRESS"
```

Polymarket's official CLI and Avalanche X/P-chain or `platform-cli` signing still need a raw key. With a remote signer those calls throw `REMOTE_SIGNER_UNSUPPORTED` instead of reading `POLYMARKET_PRIVATE_KEY` or a mnemonic from the environment. Address-only mode serves reads such as chain info and balance queries.

## What It Does

- Avalanche-first wallet boot, identity, and agent execution flows
- Unified holdings discovery across wallet balances, DeFi positions, prediction positions, and perp venues
- Cross-chain bridge, swap, and gas-funding flows
- Avalanche and multi-EVM DeFi actions
- Polymarket market reads plus official-CLI-backed execution
- Perpetual trading support for Hyperliquid

## Also Works Across EVM

Avalanche is the primary path, but Evalanche also supports Robinhood Chain, Base, Ethereum, Arbitrum, Optimism, Polygon, BSC, and other EVM networks for execution and holdings discovery.

## Docs

- [Roadmap](ROADMAP.md)
- [Release notes](docs/releases/README.md)
- [Release process](RELEASING.md)
- [Website source](website/README.md)
- [Smoke checklist](docs/live-smoke-checklist.md)
- [Protocol notes](docs/eva-protocol.md)
- [Security](SECURITY.md)
- [Open gaps](GAPS.md)
- [Security posture](VULN_NOTES.md)

## Website

The public site for [evalanche.xyz](https://evalanche.xyz) lives in [website/](website/). It is deployed separately from the npm package and is not included in the published package tarball.
Git-based Vercel deploys use [vercel.json](vercel.json) plus [build-website.mjs](scripts/build-website.mjs) to publish only the website assets, not the SDK build.

## License

MIT
