# Evalanche v1.17.0-rc.5 — signer escrow

Release candidate. The live Grok Bot box runs 1.17.0-rc.2 at `a55e307` (`a55e3075688be09431cec97acb5e7e7365abdd14`). This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, and `evalanche-1.17.0-rc.4.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.5.tgz` as a new pin. The live box is 1.17.0-rc.2 at `a55e307`. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, and `evalanche-1.17.0-rc.4.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.5.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- `provision` keeps a separate owner and mode for each state file. Claiming the root-owned `start.lock` no longer makes later files, including `audit.jsonl`, root-owned. State files stay on the signer user at mode `0600`. `start.lock` and `signer.pid` stay root at mode `0600`.
- `grok-bot-signer.sh escrow <dir>` and `restore <dir>` are opt-in. `provision` and `start` do not call them. `escrow` copies the bearer token, the nonce high-water mark, and `nonces.json.bak` backups to a box-owned directory (mode `0700`, files `0600`) and writes a sha256 manifest. `restore` checks that manifest, recreates the signer directories with their owners and modes, and refuses a nonce high-water mark below the current one.

## Upgrade

The live signer is 1.17.0-rc.2 at `a55e3075688be09431cec97acb5e7e7365abdd14`.

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.5.tgz`. Leave the rc.1, rc.2, rc.3, and rc.4 pins in place.
- Run `escrow` before a box reset when the reset keeps only files the box user can read. `restore` after the reset puts the token and the nonce store back and does not lower the high-water mark.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. pUSD approvals stay on the Polymarket module. See `docs/signer-multichain.md`.
