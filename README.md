# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.9.7](docs/releases/RELEASE_NOTES_1.9.7.md)
- Published package: `evalanche@1.9.7`
- Current package surface:
  - Hardened MCP HTTP mode so it now requires an explicit bearer token, binds to loopback by default, enforces request timeouts, and rejects oversized request bodies before parsing.
  - Routed high-risk execution helpers through active spending-policy checks, including approve-and-call, UUPS proxy upgrades, Li.Fi bridge/swap execution, and Gas.zip funding.
  - Tightened x402 paid-service hosting so settled endpoints require a settlement verifier by default, while preserving explicit `signed-intent` mode for trusted peer flows and tests.
  - Fixed Polymarket collateral normalization for live pUSD spender allowances, and made `pm_approve` / `pm_deposit` sync both wallet USDC.e -> CLOB approval and Polygon pUSD spender approvals.
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
The default MCP transport is stdio. HTTP mode is available for local automation, but requires an explicit bearer token:

```bash
EVALANCHE_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" npx evalanche-mcp --http --port 3402
```

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
