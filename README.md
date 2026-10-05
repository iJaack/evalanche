# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.14.0](docs/releases/RELEASE_NOTES_1.14.0.md)
- Published package: `evalanche@1.14.0`
- Current package surface:
  - Make Avalanche the hardened default with the official `@avalanche-sdk/client`, removing the legacy Core wallet and vulnerable HPKE dependency trees from fresh consumer installs.
  - Expand Avalanche L1 support with live mainnet and Fuji catalog discovery, RPC chain ID verification, native-token preservation, and public SDK/MCP helpers.
  - Remove the dYdX SDK, exports, MCP tools, holdings detector, and transitive Cosmos dependencies; Hyperliquid remains the supported perpetuals integration.
  - Harden X/P/C address routing, offline signing, atomic import/export polling, network switching, HTTP cancellation, response limits, audit parsing, and release automation.
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

Avalanche remains the default network. Native X/P/C operations use `@avalanche-sdk/client`; the legacy Core wallet tree and dYdX support, exports and tools are removed. Hyperliquid perpetuals remain. v1.14.0 requires Node.js 20 or newer; review its migration notes before upgrading.

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
