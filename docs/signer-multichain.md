# Signer chains, Polymarket, and Avalanche LP

The reference signer still requires an Ed25519 verifier approval, a JCS intent hash, and a single-use approval nonce. This page is the config added on top of that. Nothing here turns a module on by itself. The Grok Bot provision template is unchanged.

## Chains

A file with no `chains` object is the old shape: `chainId` or `chainIds`, one `rpcUrl`, address-keyed `tokenCaps`, one `maxGasCostWei`, one `priceSourceUrl`, and one `slippageCaps`. On that file Avalanche behaves as before. A testnet in `chainIds` is refused.

`chains` replaces that list. 43114 is enabled unless its entry sets `enabled: false` or `killSwitch: true`. Any other mainnet is enabled only with `enabled: true`. The kill switch wins. The nineteen mainnets are 1, 10, 25, 56, 100, 137, 250, 324, 1284, 4663, 5000, 8453, 42161, 42220, 43114, 59144, 80094, 81457, and 534352.

Each entry may set:

- `rpcUrls`. Simulation uses this list for the request's chain. The first success wins. A revert does not fall through. An injected test simulator still replaces the list.
- `gas.mode`: `legacy` (type 0), `eip1559` (type 2), or `both`. Type 113 is denied on every chain. `gas.maxFeeWei` is the native gas-cost cap and cannot exceed 1 native token. `gas.maxFeeUsd` is an optional USD cap on that same cost.
- `tokenCaps`. Keyed by chain, then by address or `native`. The same address on two chains does not share a cap. A top-level `tokenCaps` whose keys are chain ids is the same map.
- `slippageCaps`, `lifiDiamond`, `lifiSelectors`, and `kyberExecutors`. Avalanche keeps the built-in stable and top slippage classes. Other chains use only the lists in config. An omitted Kyber list on a non-Avalanche chain allows no executor.
- `price.ids` and `price.sanitySource`. The feed is HTTPS and keyed by address. When `ids` is set, an address missing from it has no price.

Enabling a chain other than Avalanche re-opens TM-008 for that chain. The signer is still not a boundary against root.

## Polymarket

`chains.137.polymarket.enabled` defaults to off. Orders use kind `polymarket-order`, not generic typed data. Generic typed data still denies the Polymarket domain and `ClobAuthDomain`.

The signed type string is:

```text
Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)
```

The typehash is `0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589`. The domain is name `Polymarket CTF Exchange`, version `2`, chain id 137, and `verifyingContract` either `0xE111180000d2663C0091e4f400237545B87B996B` (standard) or `0xe2222d279d744050d28e00520010520000310F59` (neg risk). `negRisk` on the intent must match that contract. Version `3` and `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` stay denied unless `v3Exchange` is true.

The order must have maker and signer equal to the treasury, `signatureType` 0, and a token id on `markets`. BUY notional is `makerAmount`. SELL notional is `takerAmount`. Price is collateral divided by shares, and it must sit within `priceBand` of the verifier's `mid` (default 0.02). The timestamp must be within 120 seconds. Salt and order hash are recorded so they cannot be signed twice. `maxOrdersPerDay` counts orders in the UTC day. A SELL size must be within the verifier's `balance`.

`perOrderPctNav`, `perMarketPctNav`, and `totalOpenPctNav` are hard ceilings. A proposer may send a lower percent on the intent. A higher percent is rejected. BUY also checks the market and total open notionals. SELL checks the per-order ceiling only.

`orderType` must be `FOK`. That declaration is bound by the intent hash. The EIP-712 order does not include expiration, nonce, feeRateBps, or taker. The signer cannot enforce them. The allow audit line says so.

`clobAuth: true` is a separate flag. The domain is `ClobAuthDomain` version `1` on chain 137, with no verifying contract. The address is the treasury, the nonce is 0, and the message is `This message attests that I control the given wallet`. Each payload is one-use. It does not count toward the daily order cap.

Gated Polygon transactions, and only these:

- CTF `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` `setApprovalForAll` to a current V2 exchange, with `approved` true.
- CTF `redeemPositions` with collateral USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` or pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, and `parentCollectionId` zero.
- NegRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` `redeemPositions`.
- `approve(spender, 0)` of that collateral to a Polymarket contract. A positive amount stays denied.

Split, merge, onramp, offramp, and calls to the exchanges stay denied. A second collateral-adapter pair was not verified, so it is not pinned and stays denied.

A Polymarket L2 API secret is a new box-wide secret. This signer does not store it.

## Avalanche concentrated liquidity

`chains.43114.clmm.enabled` defaults to off. The module is only valid on chain 43114.

Pinned contracts, checked against `https://api.avax.network/ext/bc/C/rpc` on 18 October 2026:

- Factory `0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD`. `getPool(WAVAX, USDC, 500)` returned `0xfAe3f424a0a47706811521E3ee268f00cFb5c45E`.
- Pool `0xfAe3f424a0a47706811521E3ee268f00cFb5c45E`. `token0` is WAVAX `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7`, `token1` is USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, fee 500, tick spacing 10, factory the address above.
- NonfungiblePositionManager `0x655C406EBFa14EE2006250925e54ec43AD184f8B`. `factory()` returned the factory above.

Allowed:

- `approve` of WAVAX or USDC to the position manager for an exact positive amount at or under the pool cap. `MaxUint256` is denied.
- `mint` of an allowlisted `(token0, token1, fee)`. Ticks must sit on the spacing and inside the configured bounds. `amount0Min` and `amount1Min` must be nonzero when that side is deposited. The deadline must be in the future and at most 600 seconds ahead. The recipient must be the treasury.
- `collect` to the treasury, `decreaseLiquidity` with at least one nonzero `amountMin`, and `burn`. Each requires the token id in `intent.clmm.ownedTokenIds`. The verifier checks `ownerOf`. The signer binds that list. It does not call the chain.
- `multicall` when every inner call passes the same checks. One bad inner call rejects the whole transaction. Nested multicall is denied.

Blocked: NFT `approve`, `setApprovalForAll`, `transferFrom`, and both `safeTransferFrom` forms. `increaseLiquidity` is blocked unless `clmm.increaseLiquidity` is true.

While the module is enabled, WAVAX and USDC gain the `token` role and the `transfer` and `approve` selectors on the 43114 allow map so a swap can fund the position. With the module off, that injection does not happen and the provision allow map is unchanged.

Transaction value must be 0.
