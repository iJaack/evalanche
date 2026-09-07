# Evalanche

Avalanche-first agent wallet and execution SDK for AI agents, with multi-EVM support for holdings, payments, DeFi, bridge flows, prediction markets, and perpetuals.

<!-- GENERATED:release-summary:start -->
## Current Release

- Latest release: [v1.13.0](docs/releases/RELEASE_NOTES_1.13.0.md)
- Published package: `evalanche@1.13.0`
- Current package surface:
  - Fix vault holdings conversion failures: preserve verified shares, omit unavailable underlying assets, emit a warning and lower confidence until conversion recovers.
  - Run SDK tests, type checking, builds, docs parity, package validation and audit gates on pull requests and main pushes. Bound test workers to reduce CPU contention without increasing assertion timeouts.
  - Add bounded live read compatibility checks for Avalanche, Robinhood Chain, Hyperliquid, Polymarket and LI.FI quotes, with timestamped commit-linked evidence and a daily workflow.
  - Update axios, protobufjs, tiny-secp256k1, Hyperliquid, valibot, Vite, follow-redirects and @protobufjs/utf8; remove unused direct dependencies and make dYdX optional. The production audit baseline is now zero critical and zero high findings.
- Docs:
  - [Release notes](docs/releases/README.md)
  - [Roadmap](ROADMAP.md)
  - [Release process](RELEASING.md)
  - [Security](SECURITY.md)
<!-- GENERATED:release-summary:end -->

## Install

```bash
npm install evalanche
# Skip the optional dYdX SDK if you do not use it:
npm install evalanche --omit=optional
```

**Dependency security:** npm ignores overrides inside installed dependencies. To use Evalanche's audited resolutions, merge the shipped `security-overrides.json` into your application's root `package.json` overrides and reinstall. Review any conflicts with your existing overrides. A plain install still inherits upstream advisories; zero high/critical counts apply to the configured tree.

For a new consumer project without existing overrides:

```bash
npm install evalanche
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); if(p.overrides) throw new Error("Merge existing overrides manually"); p.overrides=JSON.parse(fs.readFileSync("node_modules/evalanche/security-overrides.json","utf8")); fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
npm install
npm audit --omit=dev
```

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
- Perpetual trading support for Hyperliquid and dYdX

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
