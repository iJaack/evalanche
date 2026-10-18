# Evalanche v1.17.0-rc.1 — Multichain Kyber routes, CoinGecko prices, and direct DEX venues

Release candidate. The live Grok Bot box still runs 1.16.0 at `b788bd5` (`b788bd50c2df91eb253d6f61d08847249437811e`) with a multichain config on chains 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. This rc is not deployed.

## Highlights

- Keep the live box on 1.16.0 at `b788bd5` until it is provisioned. That box has a multichain config on chains 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. Upgrading means provisioning `evalanche-1.17.0-rc.1.tgz` and, only when static prices are dropped, setting `price.priceFeed` to `coingecko`.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.1.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- Add direct swap venues for Cronos (VVS), Gnosis and Celo (Uniswap SwapRouter02), and Mantle (Agni). They stay off until `dex.enabled`. Fantom, zkSync Era, Moonbeam, Blast, and Scroll are not implemented. Mantle also requires `poolDepthVerified` and `verifiedAt`, because pool depth must be rechecked first.

## Upgrade

The live signer is 1.16.0 at `b788bd50c2df91eb253d6f61d08847249437811e`. Its enabled chains are 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094.

Two things change for an upgrade:

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.1.tgz`. Copy that tarball to the box and pass its published sha256 to `provision`. The pin name does not come from `/opt` or from the directory that contains the script, so a wiped `/opt` can still be rebuilt from `$DURABLE/bin/grok-bot-signer.sh`. As root, `EVALANCHE_BOX_TARBALL` is ignored. A source file named `evalanche-<version>.tgz` must use that same version.
- `price.priceFeed` can replace static `price.prices` with CoinGecko `simple/price` on `api.coingecko.com` only. Leave the existing prices in place to keep the 1.16.0 price behavior. Set the feed only when those static prices should be dropped. An enabled feed still needs a positive static native price or `price.bounds` for native. Each returned price must fall inside its bound, when one is set, and within 50% of a positive static price, when one is set. A malformed, missing, stale, or out-of-range response is refused and the static price is not used as a fallback.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. Non-Avalanche chains still need `kyberExecutors`, and chains 4663, 59144, and 80094 still need `lifiDiamond` set to the pinned diamond. Direct venues for Cronos, Gnosis, Celo, and Mantle stay off until `dex.enabled`. On Mantle the verifier must re-read Agni pool depth before approving a swap, and the signer will not start that venue until `poolDepthVerified` is true and `verifiedAt` is the date of that read. See `docs/signer-multichain.md`.
