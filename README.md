# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.9.2](docs/releases/RELEASE_NOTES_1.9.2.md)
- Published package: `evalanche@1.9.2`
- Current package surface:
  - Added macOS Keychain fallback for agent credentials, so Mony and other local agents can resolve the `EvaWallet` / `EvaMain` sovereign wallet after OpenClaw secrets and env vars and before the encrypted keystore path
  - Made Polymarket orderbook handling deterministic by sorting visible bids highest-first and asks lowest-first before pricing, preflight, and sell-fill estimation
  - Preserved the `v1.9.0` Polymarket withdrawal flow while promoting the Mony-tested Evalanche runtime fixes into the public release line
  - Added focused regression coverage for keychain credential resolution and unsorted CLOB orderbook arrays
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

## Quick Start

```typescript
import { Evalanche } from 'evalanche';

const { agent } = await Evalanche.boot({ network: 'avalanche' });

console.log(agent.address);

const holdings = await agent.holdings().scan();
console.log(holdings.summary);
```

## MCP

```bash
npx evalanche-mcp
```

Evalanche ships an MCP server for wallet actions, holdings discovery, DeFi, bridge and swap flows, Polymarket, and perpetual venues.

## What It Does

- Avalanche-first wallet boot, identity, and agent execution flows
- Unified holdings discovery across wallet balances, DeFi positions, prediction positions, and perp venues
- Cross-chain bridge, swap, and gas-funding flows
- Avalanche and multi-EVM DeFi actions
- Polymarket market reads and execution
- Perpetual trading support for Hyperliquid and dYdX

## Also Works Across EVM

Avalanche is the primary path, but Evalanche also supports Base, Ethereum, Arbitrum, Optimism, Polygon, BSC, and other EVM networks for execution and holdings discovery.

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

The public site for [evalanche.xyz](https://evalanche.xyz) lives in [website/](/Users/jaack/Desktop/Github/evalanche/website). It is deployed separately from the npm package and is not included in the published package tarball.
Git-based Vercel deploys use [vercel.json](/Users/jaack/Desktop/Github/evalanche/vercel.json) plus [build-website.mjs](/Users/jaack/Desktop/Github/evalanche/scripts/build-website.mjs) to publish only the website assets, not the SDK build.

## License

MIT
