# Evalanche v1.17.0-rc.4 — CCTP messenger pin

Release candidate. The live Grok Bot box runs 1.17.0-rc.2 at `a55e307` (`a55e3075688be09431cec97acb5e7e7365abdd14`). This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, and `evalanche-1.17.0-rc.3.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.4.tgz` as a new pin. The live box is 1.17.0-rc.2 at `a55e307`. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, and `evalanche-1.17.0-rc.3.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.4.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- A CCTP `receiveMessage` is accepted only when the header sender and the header recipient are both TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`. TokenMinterV2 mints the USDC and is not the header recipient. `sourceDomains` is the receive list and is required on Polygon. `destinationDomains` is the burn list and is required on Avalanche. `maxExpirationBlock` is an optional decimal string. Omitted, only expiration 0 is accepted. A nonzero expiration at or under the bound is accepted.
- Revoke and CCTP intents use one venue/action pair each: `revoke` / `revoke`, `cctp` / `cctp-approve`, `cctp` / `cctp-burn`, and `cctp` / `cctp-mint`. `tokenIn` is the token. `amountIn` is 0 for a revoke, the approve amount for `cctp-approve`, and the USDC amount for a burn or a mint. Any other label, or an amount that does not match the calldata, is denied. A V1 CTF `setApprovalForAll(false)` uses venue `polymarket` and action `polymarket-kill`.
- `revokeOnly` accepts a zero approve or `setApprovalForAll(operator, false)` only for a contract with the `token` role or a pinned known USDC. An allowlisted router is out of scope.
- Polymarket `maxOrderUsd` and `maxDailyUsd` must be strings. A number fails startup. A same-UTC-day order stored without `usdMicros` counts at `maxOrderUsd`. If `maxOrderUsd` is unset, those records block new orders. Yesterday's records and clob-auth do not count. `unpauseUser` defaults off. When it is true, `unpauseUser()` on either V2 exchange is accepted.
- An unknown signer, chain, gas, price, allow, Polymarket, CLMM, DEX, CCTP, or revoke-only key fails startup.

## Upgrade

The live signer is 1.17.0-rc.2 at `a55e3075688be09431cec97acb5e7e7365abdd14`.

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.4.tgz`. Leave the rc.1, rc.2, and rc.3 pins in place.
- Polygon CCTP now requires `sourceDomains`. A config that still lists the source on `destinationDomains` fails startup. Avalanche still requires `destinationDomains` for burns.
- `revokeOnly`, `cctp`, and `polymarket.unpauseUser` stay off until their flags are set.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. pUSD approvals stay on the Polymarket module. See `docs/signer-multichain.md`.
