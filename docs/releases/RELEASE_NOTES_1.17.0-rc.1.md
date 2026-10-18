# Evalanche v1.17.0-rc.1 — Multichain Kyber routes and CoinGecko prices

Release candidate. The live Grok Bot box still runs 1.16.0 at `b788bd5` (`b788bd50c2df91eb253d6f61d08847249437811e`) with a multichain config on chains 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. This rc is not deployed.

## Highlights

- Keep the live box on 1.16.0 at `b788bd5` until it is provisioned. That box has a multichain config on chains 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. Upgrading means provisioning `evalanche-1.17.0-rc.1.tgz` and, only when static prices are dropped, setting `price.priceFeed` to `coingecko`.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from package.json. This rc pins `evalanche-1.17.0-rc.1.tgz`. The live 1.16.0 install used the previous tarball name. As root, `EVALANCHE_BOX_TARBALL` is ignored. `start` does not need package.json and does not rename an install that is already on disk.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The feed is HTTPS only, mapped by coin id, and fails closed on a malformed, missing, or stale price. Static prices stay valid. Switching the live config to the feed is optional.

## Upgrade

The live signer is 1.16.0 at `b788bd50c2df91eb253d6f61d08847249437811e`. Its enabled chains are 1, 10, 56, 137, 4663, 8453, 42161, 43114, 59144, and 80094.

Two things change for an upgrade:

- `provision` reads the version from `package.json` and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.1.tgz`. Copy that tarball to the box and pass its published sha256 to `provision`. As root, `EVALANCHE_BOX_TARBALL` is ignored, so the filename has to match the version inside the package.
- `price.priceFeed` can replace static `price.prices` with CoinGecko `simple/price`. Leave the existing prices in place to keep the 1.16.0 price behavior. Set the feed only when those static prices should be dropped. A malformed, missing, or stale response is refused.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. Non-Avalanche chains still need `kyberExecutors`, and chains 4663, 59144, and 80094 still need `lifiDiamond` set to the pinned diamond. See `docs/signer-multichain.md`.
