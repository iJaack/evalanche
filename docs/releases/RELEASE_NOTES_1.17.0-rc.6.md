# Evalanche v1.17.0-rc.6 — restore hardening

Release candidate. This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, and `evalanche-1.17.0-rc.5.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.6.tgz` as a new pin. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, and `evalanche-1.17.0-rc.5.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.6.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- `provision` keeps a separate owner and mode for each state file. Claiming the root-owned `start.lock` no longer makes later files, including `audit.jsonl`, root-owned. State files stay on the signer user at mode `0600`. `start.lock` and `signer.pid` stay root at mode `0600`.
- `restore` creates the `evalanche-signer` user when it is missing. Run escrow before a reset, then restore, then provision, then start. A missing current nonce file requires `--min-nonce` and/or a `--floor` file outside the escrow directory. The compare covers the whole nonce state, and the manifest only detects accidental corruption.

## Upgrade

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.6.tgz`. Leave the rc.1, rc.2, rc.3, rc.4, and rc.5 pins in place.
- Run `escrow` before a box reset. After the reset, `restore` creates the signer account, refuses to run while the signer or its start lock is held, and refuses a nonce state below the current file or the explicit floor. Then run `provision` and `start`.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. The escrow manifest is a corruption check, not a tamper seal. pUSD approvals stay on the Polymarket module. See `docs/signer-multichain.md` and `docs/deploy/grok-bot-box.md`.
