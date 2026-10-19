# Evalanche v1.17.0-rc.3 — Revoke-only approvals

Release candidate. The live Grok Bot box runs 1.17.0-rc.2 at `a55e307` (`a55e3075688be09431cec97acb5e7e7365abdd14`). This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz` and `evalanche-1.17.0-rc.2.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.3.tgz` as a new pin. The live box is 1.17.0-rc.2 at `a55e307`. Leave `evalanche-1.17.0-rc.1.tgz` and `evalanche-1.17.0-rc.2.tgz` in place. Provisioning again under either filename would overwrite a rollback pin.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.3.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- Add `chains[id].revokeOnly`, off unless `enabled` is true. It accepts `approve(anySpender, 0)` and `setApprovalForAll(operator, false)` for an allowlisted contract or a pinned known USDC. Polygon USDC.e and native USDC can be cleared from the no-code address `0x794a61358d6845594f3DCa32f21763fB5b21AbDf`. A positive amount, `operator = true`, permit, increaseAllowance, a nonzero value, and trailing calldata are denied. A bad config fails startup.
- Treat pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` as a Polygon swap token on a Li.Fi and Kyber route when it has the `token` role, no selectors, a token cap, and a stable slippage class. Omitting the stable class uses the 300 bps other cap. pUSD approvals stay on the Polymarket module. CollateralOnramp stays denied.

## Upgrade

The live signer is 1.17.0-rc.2 at `a55e3075688be09431cec97acb5e7e7365abdd14`.

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.3.tgz`. Leave the rc.1 and rc.2 pins in place.
- `revokeOnly` stays off until `chains[id].revokeOnly.enabled` is set. The chain itself still has to be enabled.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. pUSD approvals stay on the Polymarket module. See `docs/signer-multichain.md`.
