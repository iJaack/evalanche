# Signer chains, Polymarket, and Avalanche LP

The reference signer still requires an Ed25519 verifier approval, a JCS intent hash, and a single-use approval nonce. This page is the config added on top of that. Nothing here turns a module on by itself. The Grok Bot provision template is unchanged.

## Chains

A file with no `chains` object is the old shape: `chainId` or `chainIds`, one `rpcUrl`, address-keyed `tokenCaps`, one `maxGasCostWei`, one `priceSourceUrl`, and one `slippageCaps`. On that file Avalanche behaves as before. A testnet in `chainIds` is refused.

`chains` replaces that list. 43114 is enabled unless its entry sets `enabled: false` or `killSwitch: true`. Any other mainnet is enabled only with `enabled: true`. The kill switch wins. The nineteen mainnets are 1, 10, 25, 56, 100, 137, 146, 999, 1284, 4663, 5000, 8453, 42161, 42220, 43114, 59144, 80094, 81457, and 534352. Fantom 250 and zkSync Era 324 are not in the registry. Fantom Opera was sunset. zkSync EraVM bytecode cannot be checked against audited EVM bytecode. Either id fails startup as an unknown chain. Transaction type 113 stays denied.

Each entry may set:

- `rpcUrls`. Simulation uses this list for the request's chain. The first success wins. A revert does not fall through. An injected test simulator still replaces the list.
- `gas.mode`: `legacy` (type 0), `eip1559` (type 2), or `both`. Type 113 is denied on every chain. `gas.maxFeeWei` is still the native gas-cost cap and cannot exceed 1 native token. `gas.maxFeeUsd` is required and must be positive for every enabled chain. It prices that chain's own native token. An old file with no `chains` object keeps the wei cap and does not require the USD cap.
- `tokenCaps`. Keyed by chain, then by address or `native`. The same address on two chains does not share a cap. A top-level `tokenCaps` whose keys are chain ids is the same map. A non-empty address-keyed `tokenCaps` cannot be combined with `chains`. Every enabled chain needs a `native` cap and a cap for each allowlisted token, including WAVAX and USDC when the LP module is on. A disabled chain does not.
- `slippageCaps`, `lifiDiamond`, `lifiSelectors`, and `kyberExecutors`. Avalanche keeps the built-in stable and top slippage classes. Other chains use only the lists in config. An omitted Kyber list on a non-Avalanche chain allows no executor.
- `price.ids`, `price.prices`, `price.sanitySource`, and `price.priceFeed`. Prices belong to that chain. `price.prices` is an address, or `native`, to a USD number. `price.sanitySource` is an HTTPS feed keyed by address. `price.priceFeed` is `coingecko`, or `{ provider: "coingecko", url, maxAgeMs }`. It cannot be combined with `sanitySource`. The URL must be `https://api.coingecko.com/api/v3/simple/price`. `pro-api.coingecko.com` is not accepted. The signer requests `ids`, `vs_currencies=usd`, and `include_last_updated_at=true`. `price.ids` maps an address or `native` to a coin id. When `native` is omitted, the default is `ethereum` on 1, 10, 4663, 8453, 42161, and 59144, `binancecoin` on 56, `polygon-ecosystem-token` on 137, `sonic-3` on 146, `hyperliquid` on 999, `avalanche-2` on 43114, and `berachain-bera` on 80094. A chain with no default id must set `native` or a static native price. A feed price must be a positive finite USD number whose `last_updated_at` is within 10 minutes, or `maxAgeMs`. A malformed, missing, or stale price is refused and the previous value is not kept. Redirects are refused, the body is capped at 1 MB, and the request times out after 5 seconds. A static price is optional and the feed replaces it on success. It is not a fallback. Each feed price must fall inside `price.bounds` for that asset, or within 50% of a positive static price when one is set. Both checks apply when both are set. A feed price with neither is refused. `price.bounds` maps `native` or an address to `{ min, max }`, with `min` positive and `max` at least `min`. An enabled chain needs a static native price, `sanitySource`, or a price feed with a native coin id. A feed also needs a positive static native price or a native bound. The global `prices` map, `priceSourceUrl`, and `priceFeed` stay on the old single-chain file and are not copied once `chains` is set. When `ids` is set, an address missing from it has no price, except the native coin when the feed supplies a default id.
- `dex`. A direct swap venue for chains the Kyber plus Li.Fi path cannot serve. Off unless `dex.enabled` is true. The chain's own `enabled` flag is separate. Both stay off until an operator sets them. An enabled venue requires `dex.pools`, one entry per allowed token pair. V3 entries also pin `fee`. A hop outside that list is denied, including a middle hop. A direct swap requires `quotedAmountOut`. `minOut` must be at least that quote after the bought-token class slippage, and the quote itself must sit inside the bought-token cap. On Mantle 5000, `dex.enabled` also requires `poolDepthVerified: true` and `verifiedAt` as a `YYYY-MM-DD` date on or before today. The best Agni pool is about $14k TVL, so Mantle stays off. See Direct swap venues.

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
| 146 | sonic | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | wS `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38` |
| 999 | hyperevm | `0x0a0758d937d1059c356D4714e57F5df0239bce1A` | WHYPE `0x5555555555555555555555555555555555555555` |
| 4663 | robinhood | `0xB477751B76CF82d00a686A1232f5fCD772414Af3` | WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 8453 | base | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0x4200000000000000000000000000000000000006` |
| 42161 | arbitrum | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| 43114 | avalanche | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | WAVAX `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` |
| 59144 | linea | `0xDE1E598b81620773454588B85D6b5D4eEC32573e` | WETH `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` |
| 80094 | berachain | `0xf909c4Ae16622898b885B89d7F839E0244851c66` | WBERA `0x6969696969696969696969696969696969696969` |

The router on every row is `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. Native swaps still use the `0xeeee…` sentinel. `wrappedNative` is the ERC-20 above.

Sonic 146 and HyperEVM 999 were checked on 18 October 2026 and are safe on this path. Sources: [Sonic network details](https://docs.soniclabs.com/sonic/build-on-sonic/getting-started), [Sonic contract addresses](https://docs.soniclabs.com/sonic/build-on-sonic/contract-addresses), [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm), [Wrapped HYPE](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/wrapped-hype), the Kyber contract and slug pages above, `GET https://li.quest/v1/chains`, and `GET https://li.quest/v1/token`. `eth_chainId` on `https://rpc.soniclabs.com` is 146. `eth_chainId` on `https://rpc.hyperliquid.xyz/evm` is 999. Wrapped Sonic `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38` returned `symbol()` `wS`, `decimals()` 18, and 2636 bytes of code. Wrapped HYPE `0x5555555555555555555555555555555555555555` returned `symbol()` `WHYPE`, `decimals()` 18, and 2041 bytes of code. Both match the Li.Fi token record. The Kyber router has 13724 bytes of code on each chain. Sonic's diamond is the canonical address, 5176 bytes, and `facets()` includes `0x4666fc80`. HyperEVM's diamond is `0x0a0758d937d1059c356D4714e57F5df0239bce1A`, also 5176 bytes, and `facets()` includes `0x4666fc80`. The canonical diamond has no code on HyperEVM. The AggregationExecutorProxy `0x8F10B468b06c6FD214B65F87778827F7D113f996` has 13529 bytes on both. CoinGecko ids are `sonic-3` for S and `hyperliquid` for HYPE. There is no separate direct DEX pin. `dex.enabled` fails startup on both chains because no direct venue is pinned. Both chains stay off until `enabled: true`.

The signer still defaults `lifiDiamond` to the canonical diamond and `kyberExecutors` to the Avalanche executor only on 43114. A swap on 4663, 59144, 80094, or 999 needs `chains.<id>.lifiDiamond` set to the diamond in the table. A swap on any chain other than Avalanche needs `kyberExecutors` to include `0x8F10B468b06c6FD214B65F87778827F7D113f996`. The builder does not change those defaults.

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

## Direct swap venues

Checked 18 October 2026. The Kyber MetaAggregationRouter plus the Li.Fi diamond is the swap path for the chains in the table above, including Sonic 146 and HyperEVM 999. It does not serve Cronos 25, Gnosis 100, Mantle 5000, Celo 42220, Moonbeam 1284, Blast 81457, or Scroll 534352. Those chains get one pinned router, or no venue. The Li.Fi diamond is upgradeable, so it was not reused where an immutable router can be fully decoded.

`chains[id].dex.enabled` defaults to off. The chain itself still defaults to off except Avalanche. Turning the venue on does not turn the chain on. Config may set `router`, `wrappedNative`, and `selectors` only to the pin: a different router or wrapped native is rejected, and `selectors` must be a non-empty subset of the pinned outer selectors. An enabled venue must set `dex.pools` to a non-empty list. Each entry is `tokenA`, `tokenB`, and, on v3, `fee` (a positive integer up to 1000000). A v2 entry must omit `fee`. The pair match is unordered. Startup fails when the list is missing, empty, or the wrong shape for that router. An enabled chain with this venue on must also have a cap for the pinned wrapped native, a cap for every allowlisted token, a native cap, a positive `gas.maxFeeUsd`, and a native price or HTTPS feed. The signer will not start without them.

A signed swap uses kind `dex-swap`. The action is `swap`, so `minAmountOut` is required. The intent must also set `quotedAmountOut`. The signer denies the swap when that quote is missing, zero, or above the bought-token cap. `minOut` must be at least `quotedAmountOut × (10000 − class bps) / 10000`, using the intent's `maxSlippageBps` when it is within the class cap and the class cap otherwise. A missing quote fails closed. The same floor already applies to a Li.Fi V3 swap, which is the path Sonic 146 and HyperEVM 999 use. Those two chains have no direct router, so they have no `dex.pools`. The decoder allows only the selectors below. Every path token needs the `token` role. The path is two or three tokens, and every hop must be in `dex.pools`. A fee tier that is not listed is denied, including a middle hop of a packed path. The recipient is the treasury. `amountOutMin` is nonzero. `sqrtPriceLimitX96` must be 0. The deadline is in the future and at most 600 seconds ahead. Transaction value is 0, so the native asset is wrapped first. There is no ETH-in, ETH-out, or fee-on-transfer selector. A multicall is signed only when every inner call passes the same checks. Nested multicall is denied. Trailing bytes are denied. Allowlisting the router selector while the venue is off does not bypass the decoder.

### Implemented, off by default

| Chain | Venue | Style | Router | Factory | Wrapped native | Safe |
| --- | --- | --- | --- | --- | --- | --- |
| Cronos 25 | VVS Finance | Uniswap v2 | `0x145863Eb42Cf62847A6Ca784e6416C1682b1b2Ae` | `0x3B44B2a187a7b3824131F8db5a74194D0a42Fc15` | WCRO `0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23` | yes, off until enabled |
| Gnosis 100 | Uniswap SwapRouter02 | SwapRouter02 | `0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be` | `0xe32F7dD7e3f098D518ff19A22d5f028e076489B1` | WXDAI `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` | yes, only WXDAI/USDC.e fee 100 |
| Celo 42220 | Uniswap SwapRouter02 | SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` | CELO `0x471EcE3750Da237f93B8E339c536989b8978a438` | yes, only CELO/USDT fee 100 |
| Mantle 5000 | Agni SwapRouter | SwapRouter (deadline in the struct) | `0x319B69888b0d11cEC22caA5034e25FfFBDc88421` | `0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035` | WMNT `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` | no, keep off (best pool about $14k) |

Outer selectors:

- Cronos: `swapExactTokensForTokens` (`0x38ed1739`) only. VVS has no `multicall(bytes[])` (`0xac9650d8`) and no `multicall(uint256,bytes[])` (`0x5ae401dc`). Both selectors are denied.
- Gnosis and Celo: only `multicall(uint256,bytes[])`. Inners are `exactInputSingle` (`0x04e45aaf`) and `exactInput` (`0xb858183f`). A bare `exactInputSingle` has no deadline, so it is denied. `unwrapWETH9` and `sweepToken` are denied.
- Mantle: `exactInputSingle` (`0x414bf389`), `exactInput` (`0xc04b8d59`), and `multicall(bytes[])`. The deadline sits on each swap. `multicall(uint256,bytes[])` is not in the Agni bytecode, so it is not an outer selector.

The pool allowlist below is the one an operator sets in `dex.pools` before turning a venue on. The shipped default leaves `dex.enabled` false, so these entries are not active until that flag is set. Mantle is not in the list.

```json
{
  "25": {
    "dex": {
      "enabled": false,
      "pools": [
        { "tokenA": "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23", "tokenB": "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59" },
        { "tokenA": "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23", "tokenB": "0x66e428c3f67a68878562e79A0234c1F83c208770" }
      ]
    }
  },
  "100": {
    "dex": {
      "enabled": false,
      "pools": [
        { "tokenA": "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", "tokenB": "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", "fee": 100 }
      ]
    }
  },
  "42220": {
    "dex": {
      "enabled": false,
      "pools": [
        { "tokenA": "0x471EcE3750Da237f93B8E339c536989b8978a438", "tokenB": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", "fee": 100 }
      ]
    }
  }
}
```

Cronos 25 is WCRO with USDC `0xc21223249CA28397B4B6541dfFaEcC539BfF0c59` and USDT `0x66e428c3f67a68878562e79A0234c1F83c208770`. V2 has no fee tier. Gnosis 100 is only WXDAI with USDC.e `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` at fee 100. Celo 42220 is only CELO with USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` at fee 100.

Cronos. Source: [VVS router docs](https://docs.vvs.finance/docs/smart-contracts-and-security/vvs-exchange-contracts-vvs-router). RPC `https://cronos-evm-rpc.publicnode.com` (`evm.cronos.org` returned 403). Code is 18266 bytes, prefix `0x6080604052`, and the EIP-1967 implementation, admin, and beacon slots are empty. `swapExactTokensForTokens` is present. The router has no multicall selector, and the signer does not accept one. The WCRO/USDC pair `0xe61Db569E231B3f5530168Aa2C9D50246525b6d6` held about 5.149e25 WCRO and about 2.869e12 USDC (6 decimals, about $2.87M). WCRO/USDT is also liquid enough for a small swap (about 0.05–0.56% at $15.6). DefiLlama listed VVS Standard near $87.9M. This is the chain's dominant immutable v2 router, and the calldata is the standard Uniswap v2 encoding. Residual risk: VVS is a Uniswap v2 fork, not canonical Uniswap. The fee-on-transfer selector `0x5c11d795` is in the bytecode and is denied.

Gnosis. Source: the [official Uniswap v3 deployment list](https://gov.uniswap.org/t/official-uniswap-v3-deployments-list/24323) (recognized April 2023, Gnosis deployer). RPC `https://rpc.gnosischain.com`. Code is 24497 bytes, the same size as Ethereum SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`. There is no `owner`, `upgradeTo`, or EIP-1967 slot. `WETH9()` is WXDAI. The only liquid pool is WXDAI/USDC.e `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` at fee 100, pool `0xf5E40cC12f69121B0329c256A99F4ab3ebDfAA2E`, about $104k TVL. Old USDC `0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83` pools were empty. The WXDAI/WETH fee 500 pool `0x4a562e482e9e6b140b322ca50cc4d8535cdf85c9` had about $3 TVL and is not an allowlisted hop. DefiLlama listed Uniswap v3 on Gnosis near $5.24M, larger than Balancer near $217k. Canonical SwapRouter02 is the safest fully decoded venue. The operator still sets the token allowlist and the caps, and `dex.pools` must name this pair and fee before the venue is turned on.

Celo. Sources: the same Uniswap deployment list (May 2022, cLabs) and the [Celo v3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-celo-deployments). Older docs call this contract SwapRouter. On chain it is SwapRouter02: 24497 bytes, `exactInputSingle` `0x04e45aaf`, `multicall(uint256,bytes[])` `0x5ae401dc`. RPC `https://forno.celo.org`. No `owner`, `upgradeTo`, `proxiableUUID`, or `admin`. `WETH9()` returns the zero address, so the pinned wrapped native is the CELO ERC-20 that the pools use. Enabling the venue therefore requires a cap on that CELO address. The liquid pool is CELO/USDT fee 100, about $194k TVL, about 0.3% loss at $15.6. CELO/USDC loses about 5.3% and CELO/cUSD loses about 1% at that size, so those pairs stay out of `dex.pools`. DefiLlama listed Uniswap v3 on Celo near $3.66M. Value must be 0. CELO is swapped as an ERC-20. Celo's native asset is also that ERC-20. This is not an EraVM chain. Residual risk: there is no WETH9 to unwrap, and a transaction that attaches value is denied.

Mantle. Agni is the venue, not canonical Uniswap. Sources: [agni-sdk `MAINNET_ADDRESSES`](https://github.com/agni-protocol/agni-sdk) and the [Agni contracts page](https://agni-finance.gitbook.io/agni/onboarding-to-agni/agni-sdk-and-contract). RPC `https://rpc.mantle.xyz`. The SwapRouter code is 9945 bytes, prefix `0x6080604052`, EIP-1967 slots empty, and `owner()`, `upgradeTo`, and `proxiableUUID` are absent. `WETH9()` reverts. `WMNT()` (`0xe8c47196`) returns `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8`. The official Uniswap SwapRouter02 `0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2` is also 24497 bytes and not a proxy, with factory `0x0d922Fb1Bc191F64970ac40376643808b4B74Df9` and the same WMNT, but the WMNT/USDC 0.3% pool `0x086f766b336dfb0f705dc030db01993b22d81266` held about 452 WMNT and about 10.5 USDC. That is not a treasury venue. Agni is the dominant DEX. DefiLlama listed it near $16.3M. The pools actually read were smaller: WMNT/USDC fee 500 `0x1858d52cf57c07a018171d7a1e68dc081f17144f` held about 3672 WMNT and about 1497.5 USDC, and WMNT/USDT fee 500 `0xd08c50f7e69e9aeb2867deff4a8053d9a855e26a` held about 1632 WMNT and about 13443515663 raw USDT (about $13k if USDT has 6 decimals). The $16.3M headline may include farms. Agni also uses fee 2500. The router ABI is the standard SwapRouter, so the calldata is fully decoded, and the contract is not upgradeable. Every hop still has to be in `dex.pools`. Residual risk: this bytecode is not canonical SwapRouter02 (9945 bytes versus 24497). Spot depth is much smaller than the DefiLlama headline. A QuoterV2 read on 18 October 2026 put the best pool, WMNT/USDT fee 500, at about $14.3k TVL. WMNT/USDC fee 500 was about $3.4k. Everything else was under $1k. A $15.6 trade lost about 1.1–1.6% in the best pools, and a $1000 trade lost about 19–60%. That is too thin for a treasury venue, so Mantle stays off. Mantle's gas token is MNT. Bridged ETH is a separate ERC-20, `0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111`, and it is not the wrapped native.

The pool-depth guard stays in place. Enabling Agni requires `dex.poolDepthVerified: true` and `dex.verifiedAt` set to a `YYYY-MM-DD` date on or before today, plus a non-empty `dex.pools` list. Startup fails without that acknowledgement and reports that pool depth must be rechecked first. The signer does not read reserves and does not treat DefiLlama's figure as spot depth. The earlier spot reads were WMNT/USDC fee 500 at about 3672 WMNT and 1497.5 USDC, and WMNT/USDT fee 500 at about 1632 WMNT and about $13k of USDT. The quoter figure of about $14k is the one that keeps the venue off. Do not enable Mantle on those pools.

### Not safe, not implemented

`dex.enabled: true` on these chains fails startup. No router is pinned for them.

| Chain | Assessed venue | Safe | Reason |
| --- | --- | --- | --- |
| Moonbeam 1284 | Uniswap SwapRouter02 `0xc507E22BA3140dc0A79fDF27e03c98aa20f3ee66` | no | Moonbeam is not safe: no liquid venue was confirmed, and the official Uniswap front-end is deprecated |
| Blast 81457 | Thruster SwapRouter `0x337827814155ECBf24D20231fCA4444F530C0555` | no | Blast is not safe: the liquid Thruster router exposes setManager, and the canonical Uniswap pools are not a treasury venue |
| Scroll 534352 | Uniswap SwapRouter02 `0xfc30937f5cde93df8d48acaf7e6f5d8d8a31f636` | no | Scroll is not safe: canonical Uniswap is not liquid, and the liquid routers take arbitrary path or callback bytes |

Moonbeam. The official Uniswap SwapRouter02 is on the governance list (May 2023, GFX Labs). The list marks the recognized front-ends as currently deprecated. One `eth_getCode` via `https://1rpc.io/glmr` returned 24497 bytes with SwapRouter02 selectors and no `owner` or `upgradeTo`. Later `factory()` and pool calls failed (HTTP 403, remote errors, or an SSL handshake failure on `rpc.api.moonbeam.network`). StellaSwap v2 is documented at `0x70085a09D30D6f8C4ecF6eE10120d1847383BB57`. StellaSwap v3 uses an Algebra SwapRouter at `0xe6d0ED3759709b743707DcfeCAe39BC180C981fe`, which takes plugin hooks, so it was not chosen. WGLMR is `0xAcc15dC74880C9944775448304B263D191c6077F`. DefiLlama showed empty or zero Moonbeam TVL for StellaSwap V2, StellaSwap V3, StellaSwap V4, BeamSwap V3, and BeamSwap Classic. No Li.Fi. No liquid venue was confirmed.

Blast. The official Uniswap SwapRouter02 `0x549FEB8c9bd4c12Ad2AB27022dA12492aC452B66` is immutable: 24497 bytes, no proxy, factory `0x792edAdE80af5fC680d96a2eD80A44247D2Cf6Fd`, WETH `0x4300000000000000000000000000000000000004`. The WETH/USDB 0.05% pool `0xf5a23bdd36a56ede75d503f6f643d5eaf25b1a8f` held about 1.496 WETH and about 8398 USDB. DefiLlama listed Uniswap v3 on Blast near $14.5k. Thruster is the liquid venue (V3 near $3.11M, V2 near $2.07M). Docs: [Thruster contracts](https://docs.thruster.finance/informational/contracts). The Thruster SwapRouter `0x337827814155ECBf24D20231fCA4444F530C0555` is 10858 bytes, EVM prefix, and its EIP-1967 slots are empty. `owner()` reverts and there is no `upgradeTo`, `proxiableUUID`, or `implementation` selector. The bytecode does contain `setManager` (`0xd0ebdbe7`), which is not in audited Uniswap. `factory()` returned the pool deployer `0xa08ae3d3f4dA51C22d3c041E468bdF4C61405AaB`. The Thruster v2 0.30% router `0x98994a9A7a2570367554589189dC9772241650f6` looks immutable (18753 bytes, no multicall selector) but the checked WETH/USDB pair `0x12c69Bfa3fb3CbA75a1DEFa6e976B87E233fc7df` held about 3.89 WETH and about 9307 USDB. Blast WETH `0x4300…0004` and USDB `0x4300…0003` are yield-bearing. Sourcify returned 404 for the Thruster router, and the Blastscan V1 API is deprecated, so the ABI was not fully fetched. An admin-settable manager on the liquid router, plus thin canonical pools, is not a treasury venue.

Scroll. The official Uniswap SwapRouter02 is on the governance list (November 2023, Scroll Foundation). RPC `https://scroll.drpc.org` (`rpc.scroll.io` returned 403). Code is 24497 bytes, not a proxy. Factory `0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919`. WETH `0x5300000000000000000000000000000000000004`. The WETH/USDC 0.05% pool `0x813df550a32d4a9d42010d057386429ad2328ed9` held about 3.51 WETH and about 3346.57 USDC. DefiLlama listed Uniswap v3 on Scroll near $23,162. SyncSwap was near $865k and uses callback bytes. Ambient was near $1.70M and uses command bytes. Neither can be fully decoded as a fixed swap. Canonical Uniswap is not liquid enough for a treasury, and the liquid routers take arbitrary bytes.
