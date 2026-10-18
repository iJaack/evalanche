# Signer chains, Polymarket, and Avalanche LP

The reference signer still requires an Ed25519 verifier approval, a JCS intent hash, and a single-use approval nonce. This page is the config added on top of that. Nothing here turns a module on by itself. The Grok Bot provision template is unchanged.

## Chains

A file with no `chains` object is the old shape: `chainId` or `chainIds`, one `rpcUrl`, address-keyed `tokenCaps`, one `maxGasCostWei`, one `priceSourceUrl`, and one `slippageCaps`. On that file Avalanche behaves as before. A testnet in `chainIds` is refused.

`chains` replaces that list. 43114 is enabled unless its entry sets `enabled: false` or `killSwitch: true`. Any other mainnet is enabled only with `enabled: true`. The kill switch wins. The nineteen mainnets are 1, 10, 25, 56, 100, 137, 250, 324, 1284, 4663, 5000, 8453, 42161, 42220, 43114, 59144, 80094, 81457, and 534352.

Each entry may set:

- `rpcUrls`. Simulation uses this list for the request's chain. The first success wins. A revert does not fall through. An injected test simulator still replaces the list.
- `gas.mode`: `legacy` (type 0), `eip1559` (type 2), or `both`. Type 113 is denied on every chain. `gas.maxFeeWei` is still the native gas-cost cap and cannot exceed 1 native token. `gas.maxFeeUsd` is required and must be positive for every enabled chain. It prices that chain's own native token. An old file with no `chains` object keeps the wei cap and does not require the USD cap.
- `tokenCaps`. Keyed by chain, then by address or `native`. The same address on two chains does not share a cap. A top-level `tokenCaps` whose keys are chain ids is the same map. A non-empty address-keyed `tokenCaps` cannot be combined with `chains`. Every enabled chain needs a `native` cap and a cap for each allowlisted token, including WAVAX and USDC when the LP module is on. A disabled chain does not.
- `slippageCaps`, `lifiDiamond`, `lifiSelectors`, and `kyberExecutors`. Avalanche keeps the built-in stable and top slippage classes. Other chains use only the lists in config. An omitted Kyber list on a non-Avalanche chain allows no executor.
- `price.ids`, `price.prices`, `price.sanitySource`, and `price.priceFeed`. Prices belong to that chain. `price.prices` is an address, or `native`, to a USD number. `price.sanitySource` is an HTTPS feed keyed by address. `price.priceFeed` is `coingecko`, or `{ provider: "coingecko", url, maxAgeMs }`. It cannot be combined with `sanitySource`. The URL must be `https://api.coingecko.com/api/v3/simple/price`. `pro-api.coingecko.com` is not accepted. The signer requests `ids`, `vs_currencies=usd`, and `include_last_updated_at=true`. `price.ids` maps an address or `native` to a coin id. When `native` is omitted, the default is `ethereum` on 1, 10, 4663, 8453, 42161, and 59144, `binancecoin` on 56, `polygon-ecosystem-token` on 137, `avalanche-2` on 43114, and `berachain-bera` on 80094. A chain with no default id must set `native` or a static native price. A feed price must be a positive finite USD number whose `last_updated_at` is within 10 minutes, or `maxAgeMs`. A malformed, missing, or stale price is refused and the previous value is not kept. Redirects are refused, the body is capped at 1 MB, and the request times out after 5 seconds. A static price is optional and the feed replaces it on success. It is not a fallback. Each feed price must fall inside `price.bounds` for that asset, or within 50% of a positive static price when one is set. Both checks apply when both are set. A feed price with neither is refused. `price.bounds` maps `native` or an address to `{ min, max }`, with `min` positive and `max` at least `min`. An enabled chain needs a static native price, `sanitySource`, or a price feed with a native coin id. A feed also needs a positive static native price or a native bound. The global `prices` map, `priceSourceUrl`, and `priceFeed` stay on the old single-chain file and are not copied once `chains` is set. When `ids` is set, an address missing from it has no price, except the native coin when the feed supplies a default id.

Enabling a chain other than Avalanche re-opens TM-008 for that chain. The signer is still not a boundary against root.

## Kyber routes

`buildKyberLifiSwap` can build a same-chain swap on each enabled chain in the table below. The router, diamond, and wrapped native are pinned. A chain that is not in the table is refused. A pinned chain that is not in `enabledChainIds` is refused. Omitted `enabledChainIds` means the whole table. The Kyber `sender` and `recipient` are that chain's diamond. An optional `recipient` on the request is the outer V3 receiver and must be the treasury. The route summary and the build must name the requested tokenIn, tokenOut, and amountIn. The router must be the pinned router. Build amountOut must be within 0.1% of the route amountOut. minOut applies the bought-token class cap.

Checked on 18 October 2026. The router is the Kyber MetaAggregationRouterV2 from [KyberSwap's contract list](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts). Slugs are from the [EVM swaps page](https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps). Diamonds are the `diamondAddress` from `GET https://li.quest/v1/chains` and [Li.Fi's address list](https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses). Wrapped natives are from `GET https://li.quest/v1/token` plus `symbol()` and `decimals()` on a public RPC. Each address had code. `facets()` on each diamond included `0x4666fc80`.

| Chain | Slug | Diamond | Wrapped native |
| --- | --- | --- | --- |
| 1 | ethereum | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| 10 | optimism | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0x4200000000000000000000000000000000000006` |
| 56 | bsc | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| 137 | polygon | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WPOL `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| 4663 | robinhood | `0xB477751B76CF82d00a686A1232f5fCD772414Af3` | WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 8453 | base | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0x4200000000000000000000000000000000000006` |
| 42161 | arbitrum | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| 43114 | avalanche | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WAVAX `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` |
| 59144 | linea | `0xDE1E598b81620773454588B85D6b5D4eEC32573e` | WETH `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` |
| 80094 | berachain | `0xf909c4Ae16622898b885B89d7F839E0244851c66` | WBERA `0x6969696969696969696969696969696969696969` |

The router on every row is `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. Native swaps still use the `0xeeee…` sentinel. `wrappedNative` is the ERC-20 above.

The signer still defaults `lifiDiamond` to the canonical diamond and `kyberExecutors` to the Avalanche executor only on 43114. A swap on 4663, 59144, or 80094 needs `chains.<id>.lifiDiamond` set to the diamond in the table. A swap on any chain other than Avalanche needs `kyberExecutors` to include `0x8F10B468b06c6FD214B65F87778827F7D113f996`. The builder does not change those defaults.

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

- CTF `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` `setApprovalForAll` to a current V2 exchange. `approved` may be true, or false to revoke that operator.
- CTF `redeemPositions` with collateral USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` or pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, and `parentCollectionId` zero.
- NegRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` `redeemPositions`.
- `approve(spender, 0)` of that collateral to a Polymarket contract. A positive amount stays denied.

- `pauseUser()` on the standard V2 exchange `0xE111180000d2663C0091e4f400237545B87B996B` or the neg-risk V2 exchange `0xe2222d279d744050d28e00520010520000310F59`. That is the user self-pause. `unpauseUser` and admin `pauseTrading` stay denied. The V3 exchange stays denied.

`pauseUser()` does not stop matching in the same block. The exchange waits its own pause delay before the pause takes effect. The call covers only the exchange it is sent to, so the standard V2 exchange and the neg-risk V2 exchange each need their own call. The signer cannot undo it: `unpauseUser` stays denied.

To cut off the venue, revoke first and pause last. Send `approve(spender, 0)` for the collateral allowance, then CTF `setApprovalForAll(V2 exchange, false)` for each current V2 exchange, then `pauseUser()` on each of those exchanges.

Split, merge, onramp, offramp, and every other call to the exchanges stay denied. A second collateral-adapter pair was not verified, so it is not pinned and stays denied.

A Polymarket L2 API secret is a new box-wide secret. This signer does not store it.

## Avalanche concentrated liquidity

`chains.43114.clmm.enabled` defaults to off. The module is only valid on chain 43114.

Pinned contracts, checked against `https://api.avax.network/ext/bc/C/rpc` on 18 October 2026:

- Factory `0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD`. `getPool(WAVAX, USDC, 500)` returned `0xfAe3f424a0a47706811521E3ee268f00cFb5c45E`.
- Pool `0xfAe3f424a0a47706811521E3ee268f00cFb5c45E`. `token0` is WAVAX `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7`, `token1` is USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`, fee 500, tick spacing 10, factory the address above.
- NonfungiblePositionManager `0x655C406EBFa14EE2006250925e54ec43AD184f8B`. `factory()` returned the factory above.

Allowed:

- `approve` of WAVAX or USDC to the position manager for an exact amount at or under the pool cap, including zero so a leftover allowance can be revoked. `MaxUint256` is denied.
- `mint` of an allowlisted `(token0, token1, fee)`. Ticks must sit on the spacing and inside the configured bounds. `amount0Min` and `amount1Min` must be nonzero when that side is deposited. The deadline must be in the future and at most 600 seconds ahead. The recipient must be the treasury.
- `collect` to the treasury, `decreaseLiquidity` with at least one nonzero `amountMin`, and `burn`. Each requires the token id in `intent.clmm.ownedTokenIds`. The signer binds that list. It does not call `ownerOf`. The verifier side, an `ownerOf` eth_call plus a `positions(tokenId)` pool match, is built separately.
- `multicall` when every inner call passes the same checks. One bad inner call rejects the whole transaction. Nested multicall is denied.

Blocked: NFT `approve`, `setApprovalForAll`, `transferFrom`, and both `safeTransferFrom` forms. `increaseLiquidity` is blocked unless `clmm.increaseLiquidity` is true.

While the module is enabled, WAVAX and USDC gain the `token` role and the `approve` selector on the 43114 allow map so a swap can fund the position. The module does not add `transfer`. A transfer selector that is already in the allow map stays. With the module off, that injection does not happen, and a call to the position manager is subject to the generic allow map. The provision allow map is unchanged.

Transaction value must be 0.
