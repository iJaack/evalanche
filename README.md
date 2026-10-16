# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.15.0](docs/releases/RELEASE_NOTES_1.15.0.md)
- Published package: `evalanche@1.15.0`
- Current package surface:
  - Add a pluggable signer so an agent can sign without a local private key in the Evalanche process.
  - Add an HTTP(S) and unix-socket remote signer client with bearer auth, request ids, timeouts, and a check that the returned signed transaction decodes to the requested fields.
  - Add `evalanche-signer`, a reference server that verifies the pinned verifier key, recomputes the intent hash from the transaction, and enforces nonce, expiry, the deny list, SpendingPolicy, token caps, and simulation.
  - Fail closed, with a typed `EvalancheError`, on paths that still need raw key material: the Polymarket CLI (`POLYMARKET_PRIVATE_KEY`) and Avalanche X/P-chain / `platform-cli` signing. Read-only tools work from an address alone.
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

`privateKey`, `mnemonic`, and `signer` are mutually exclusive. Build the intent with sorted keys via `canonicalIntentJson`, hash it with `computeIntentHash`, and have the verifier sign that 32-byte hash. `routeHash` is `computeRouteHash` of the transaction data. Swap and bridge intents must set `minAmountOut`. Attach the approval with `agent.setSigningContext({ intent, structuredIntent, approval })` before `send`, `signMessage`, or a venue call.

```bash
export EVALANCHE_SIGNER_TOKEN="$(openssl rand -hex 32)"
export EVALANCHE_SIGNER_PRIVATE_KEY="0x..."
npx evalanche-signer --config signer.json
# dry-run verifies policy and approval, then returns without a signature
npx evalanche-signer --config signer.json --dry-run
```

The signer listens on `127.0.0.1` or `--socket`. It rejects a non-loopback bind unless configured otherwise. Before it signs it checks the pinned verifier key, recomputes the intent hash from the transaction, enforces a monotonic single-use nonce and expiry, applies the deny list (Hyperliquid order tools and unlimited ERC-20 approvals by default; an `approve` amount must equal `amountIn`), runs `SpendingPolicy` plus token or USD caps, simulates, and appends the decision to a JSONL audit log.

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
