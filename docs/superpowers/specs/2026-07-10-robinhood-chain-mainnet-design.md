# Robinhood Chain Mainnet Support Design

**Date:** 2026-07-10  
**Status:** Approved for autonomous implementation  
**Scope:** Robinhood Chain mainnet only

## Context

Evalanche resolves named EVM networks through the central registry in
`src/utils/chains.ts`. Registry entries feed wallet boot, network switching,
MCP chain discovery, and native-balance holdings scans. The bridge clients use
numeric chain IDs against LI.FI, while Gas.zip execution is sourced through
LI.FI's `gasZipBridge` integration.

Robinhood's official mainnet configuration is:

- network name: `Robinhood Chain`
- chain ID: `4663`
- native gas token: `ETH` with 18 decimals
- public RPC: `https://rpc.mainnet.chain.robinhood.com`
- explorer: `https://robinhoodchain.blockscout.com`
- architecture: EVM-compatible Ethereum L2 built with Arbitrum Nitro

Official references:

- https://docs.robinhood.com/chain/connecting/
- https://docs.robinhood.com/chain/
- https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/

Read-only checks on 2026-07-10 confirmed that the public RPC returned chain ID
`0x1237` (`4663`), LI.FI listed Robinhood Chain under key `out`, and LI.FI
returned an Ethereum-to-Robinhood native ETH quote through Across. LI.FI's
current `gasZipBridge` capability matrix contained no pair with chain `4663`.

## Goals

1. Add Robinhood Chain mainnet as the named network `robinhood`.
2. Make the chain available through every existing generic EVM surface:
   wallet construction and boot, sends and contract calls, network switching,
   chain metadata, MCP discovery and switching, and native holdings scans.
3. Certify LI.FI bridge quote and execution request construction for chain
   `4663` without promising that a route is always liquid.
4. Represent current Gas.zip unavailability explicitly and fail before a
   misleading or non-Gas.zip quote can be used.
5. Document the public RPC's production caveat and provide environment-based
   RPC overrides.
6. Add unit, regression, build, and read-only live-smoke coverage.

## Non-goals

- Do not add Robinhood Chain Testnet (`46630`) or a testnet alias.
- Do not add Robinhood Stock Token contracts, protocol-specific position
  detectors, or Robinhood-specific DeFi adapters. Those are separate protocol
  integrations, not chain transport support.
- Do not implement Robinhood's canonical Arbitrum bridge. LI.FI is Evalanche's
  existing generic bridge abstraction and currently returns a live route.
- Do not execute a funded bridge, gas transfer, contract call, or token trade
  during verification. Live verification is read-only and quote-only.
- Do not claim Gas.zip supports Robinhood Chain while its advertised capability
  matrix excludes chain `4663`.

## Architecture

### Chain registry and network resolution

Add chain `4663` to `CHAINS` with:

- name `Robinhood Chain`
- short name `rh`
- currency `{ name: 'Ether', symbol: 'ETH', decimals: 18 }`
- LI.FI chain key `out`
- official public RPC as the default
- official Blockscout explorer
- an explicit `gasZipSupported: false` capability

The RPC list will accept comma-separated overrides from
`ROBINHOOD_RPC_URLS` and `EVALANCHE_ROBINHOOD_RPC_URLS` before the official
rate-limited public endpoint. This follows the existing Base override pattern
and gives production users a keyed provider path without committing secrets or
provider-specific URLs.

Add `robinhood: 4663` to `CHAIN_ALIASES` and add `'robinhood'` to `ChainName`.
The existing `NETWORKS` derivation then makes the alias available throughout
the SDK without a parallel configuration table.

### Generic EVM surfaces

No Robinhood-specific wallet class is needed. `Evalanche` already uses an
ethers `JsonRpcProvider` and signer for named EVM networks. The new registry
entry must be covered through these public behaviors:

- `new Evalanche({ network: 'robinhood' })`
- `Evalanche.boot({ network: 'robinhood' })`
- `agent.switchNetwork('robinhood')`
- `agent.getChainInfo()`
- `Evalanche.getSupportedChains()`
- MCP `get_supported_chains`, `get_chain_info`, and `switch_network`
- holdings scans with `chains: ['robinhood']`

Avalanche-only identity, staking, X/P-Chain, Arena, and Yield Yak paths remain
chain-restricted exactly as they are today.

### LI.FI bridging

The LI.FI client already accepts numeric source and destination chain IDs, so
chain `4663` does not require a new bridge adapter. Coverage will prove that a
Robinhood quote request preserves chain `4663`, native-token normalization,
addresses, and amounts. A read-only smoke check will request a current route
from a liquid source chain to Robinhood Chain.

The SDK will treat a successful LI.FI route as vendor availability at the time
of the request, not a permanent guarantee. Existing LI.FI HTTP and quote errors
remain the source of truth when liquidity or a route is unavailable.

### Gas.zip capability handling

Extend `ChainConfig` with optional `gasZipSupported`. Robinhood Chain sets it to
`false`; existing entries remain `undefined`, meaning that Evalanche has no
static override and may ask LI.FI as it does today.

Before Gas.zip quote discovery, `GasZipClient` will inspect both registry-known
source and destination chains. If either explicitly sets
`gasZipSupported: false`, it will throw `EvalancheError` with code
`GAS_ZIP_ERROR` and a message naming the unsupported chain and ID. The check
must happen before `fetch`.

Gas.zip quote requests will also set `allowBridges=gasZipBridge`. This prevents
an ordinary LI.FI bridge such as Across from being mistaken for Gas.zip. The
existing response-side tool check remains as defense in depth.

This design makes `fund_destination_gas` truthful: it is present globally, but
Robinhood requests return an explicit current capability error instead of a
generic vendor failure or an incorrectly classified bridge quote.

## Data flow

1. A caller selects `network: 'robinhood'`.
2. `getNetworkConfig` resolves the alias through `CHAIN_ALIASES` and `CHAINS`.
3. `Evalanche` constructs its provider and signer using the first configured
   RPC, honoring environment overrides before the public endpoint.
4. Wallet, MCP, and holdings consumers use the same resolved metadata.
5. LI.FI bridge methods send numeric chain ID `4663` to LI.FI.
6. Gas.zip methods read registry capability metadata and reject Robinhood
   before any external quote request.

## Error handling

- Unknown aliases continue to use the existing `Unknown network` error.
- A rate-limited or unavailable public RPC continues through ethers provider
  errors; documentation directs production users to RPC override variables.
- LI.FI route or liquidity failures remain structured `LIFI_ERROR` failures.
- Gas.zip requests involving Robinhood fail deterministically with
  `GAS_ZIP_ERROR`, name `Robinhood Chain`, and chain ID `4663`.
- No code silently falls back from Robinhood mainnet to testnet or another EVM
  chain.

## Documentation changes

- Add Robinhood Chain to the README's supported-EVM statement and a short boot
  example using `network: 'robinhood'`.
- Update `skill/SKILL.md` counts, supported-chain list, and network variable
  description from `21+` to `22+` chains.
- Add `robinhood` to package keywords.
- Add a Robinhood section to `docs/live-smoke-checklist.md` covering RPC chain
  identity, MCP discovery/switching, LI.FI quote availability, and the expected
  Gas.zip unsupported result.
- Do not alter release notes or claim the change is published until a release
  is actually cut.

## Testing strategy

Implementation follows red-green-refactor. Each behavior receives a failing
test before production code changes.

### Milestone 1: registry and core SDK support

- Registry tests assert chain `4663` metadata, the `robinhood` alias, mainnet
  filtering behavior, and absence of testnet `46630`.
- Network tests assert `NETWORKS.robinhood` and `getNetworkConfig('robinhood')`.
- Agent tests assert construction, chain info, and switching.
- MCP tests assert discovery and switching through the public tool surface.
- Holdings tests assert an explicit Robinhood native scan routes through
  `switchNetwork('robinhood')`.
- Regression gate: run all affected unit tests, then the full test suite.

### Milestone 2: bridge and capability behavior

- LI.FI tests assert quote request construction with destination chain `4663`.
- Gas.zip tests assert a Robinhood pair fails before `fetch`, with
  `GAS_ZIP_ERROR` and a precise message.
- Gas.zip regression tests assert supported pairs request
  `allowBridges=gasZipBridge` and still execute the returned transaction.
- Regression gate: run bridge tests, then the full test suite.

### Milestone 3: documentation and release-surface consistency

- Update documentation and package metadata only after behavior is green.
- Run release/documentation consistency tests.
- Run `npm run typecheck`, `npm run build`, and `npm test`.
- Perform read-only live checks: official RPC `eth_chainId`, SDK chain lookup,
  MCP discovery, and a LI.FI quote to chain `4663`.
- Confirm the Gas.zip live capability matrix still excludes `4663`; if it has
  changed, update the capability flag and tests to match current vendor truth.

## Acceptance criteria

- TypeScript accepts `network: 'robinhood'` and rejects an invented Robinhood
  testnet alias.
- All core generic EVM surfaces expose chain ID `4663` with official metadata.
- The default RPC is official, and environment overrides take precedence.
- A mocked LI.FI Robinhood route is constructed and parsed correctly.
- A read-only live LI.FI quote to Robinhood succeeds at verification time, or
  the exact current vendor blocker is reported without weakening unit coverage.
- Gas.zip cannot produce or execute a mislabeled non-Gas.zip route for
  Robinhood Chain.
- Automated tests, typecheck, and build pass with no new warnings.
- Documentation describes both supported behavior and current limitations.
