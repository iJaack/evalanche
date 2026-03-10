# Evalanche — Feature Gaps Log

> When Eva hits something Evalanche can't do, log it here. Each gap gets a subagent to fix it.

## Gap 1: DEX Swap Support (Avalanche)
- **Date:** 2026-03-04
- **Context:** Needed to buy $EVA tokens on Avalanche. Only pool is EVA/ARENA on Uniswap V4 via Arena's ArenaTokenManager.
- **What's missing:** No swap/trade functionality. Can send tokens, call contracts, but no DEX router integration.
- **Required:** 
  - Support for Arena's ArenaTokenManager (buyAndCreateLpIfPossible, sell)
  - ArenaTokenManager proxy: `0x2196e106af476f57618373EC028924767c758464`
  - PoolManager: `0x06380C0e0912312b5150364B9dc4542bA0DbBc85`
  - Support for Trader Joe V2.1 / LFJ router as fallback
  - Generic swap interface: `swap(tokenIn, tokenOut, amount, slippage)`
- **Priority:** HIGH — blocks agent self-funding on Avalanche
- **Status:** RESOLVED (v0.5.0)
- **Resolution shipped in v0.5.0:**
  - Added `src/swap/arena.ts` with `ArenaSwapClient` for ArenaTokenManager integration
  - Implemented `buyArenaToken()` and `sellArenaToken()` flows against Arena bonding curve
  - Added `calculateBuyCost()` quoting helper for pre-trade cost checks
  - Added 4 MCP tools: `arena_buy`, `arena_sell`, `arena_token_info`, `arena_buy_cost`

## Gap 2: Arena Token ID Lookup
- **Date:** 2026-03-04
- **Context:** Needed to find the Arena tokenId for $EVA to call buyAndCreateLpIfPossible.
- **What's missing:** No way to look up an Arena community token's internal ID from its ERC-20 address.
- **Required:**
  - `getArenaTokenId(tokenAddress)` — search ArenaTokenManager's 3600+ tokens by address
  - Cache results locally after first lookup
  - ArenaTokenManager impl ABI has `getTokenInfo(uint256)` returning struct with `tokenAddress`
- **Priority:** MEDIUM — needed for Gap 1
- **Status:** RESOLVED (v0.5.0)
- **Resolution shipped in v0.5.0:**
  - Implemented `getArenaTokenId(tokenAddress)` in `src/swap/arena.ts`
  - Added token ID scanning over `getTokenInfo(uint256)` with batch parallelization
  - Added module-level TTL cache for address → tokenId lookups
  - Exposed `getTokenInfo(tokenId)` for direct token metadata retrieval

## Gap 3: Contract Interaction Helpers
- **Date:** 2026-03-04  
- **Context:** Had to use raw `cast` commands for approve + registerCurator + upgradeToAndCall.
- **What's missing:** Higher-level contract interaction patterns (approve-and-call, multicall).
- **Required:**
  - `approveAndCall(token, spender, amount, contractCall)` pattern
  - UUPS upgrade helper: `upgradeProxy(proxyAddress, newImplBytecode)`
- **Priority:** LOW — cast works fine, just not SDK-native
- **Status:** OPEN

## Gap Resolved: Subnet/L1 Support
- **Date:** 2026-03-06
- **Context:** Needed subnet management, L1 validator ops, and BLS staking support.
- **Solution:** Integrated ava-labs/platform-cli as optional subprocess (v0.6.0).
- **What was added:**
  - PlatformCLI wrapper class with auto-detection
  - Subnet create/transfer-ownership/convert-to-L1
  - L1 validator register/set-weight/add-balance/disable
  - Add validator with BLS keys + node endpoint auto-discovery
  - P-Chain direct send, chain creation, node info
  - 10 new MCP tools, 34 new tests
- **Status:** RESOLVED

## Gap Resolved: dYdX v4 Perpetuals Integration
- **Date:** 2026-03-08
- **Context:** Needed perpetual futures trading support beyond EVM spot flows.
- **Solution:** Added dYdX v4 integration in Evalanche v0.7.0.
- **What was added:**
  - `DydxClient` wrapper with wallet derivation from mnemonic
  - Perp venue abstractions and dYdX market/position/order types
  - `Evalanche.dydx()` lazy initializer + `findPerpMarket()` helper
  - 10 new MCP tools for dYdX markets, balances, orders, and positions
  - Unit tests for dYdX client/types and MCP tool coverage
- **Status:** RESOLVED

## Gap Resolved: Full Li.Fi Cross-Chain Liquidity SDK
- **Date:** 2026-03-09
- **Context:** Li.Fi integration was bridge-only. Needed DEX swaps, status tracking, token discovery, gas pricing, DeFi Composer.
- **Solution:** Expanded Li.Fi integration in Evalanche v0.8.0 based on Li.Fi's llms.txt documentation.
- **What was added:**
  - 9 new LiFiClient methods (checkTransferStatus, getSwapQuote, getTokens, getToken, getChains, getTools, getGasPrices, getGasSuggestion, getConnections)
  - Same-chain DEX swaps via Li.Fi (31+ aggregators on any chain)
  - DeFi Composer support (one-tx cross-chain DeFi: Morpho, Aave V3, Euler, Pendle, Lido, EtherFi, etc.)
  - Transfer status tracking (PENDING/DONE/FAILED with substatus)
  - 11 new MCP tools (52 total), 180 tests
- **Status:** RESOLVED
