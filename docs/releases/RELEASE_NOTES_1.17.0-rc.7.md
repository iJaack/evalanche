# Evalanche v1.17.0-rc.7 — box restore

Release candidate. This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, `evalanche-1.17.0-rc.5.tgz`, and `evalanche-1.17.0-rc.6.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.7.tgz` as a new pin. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, `evalanche-1.17.0-rc.5.tgz`, and `evalanche-1.17.0-rc.6.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
- Build KyberSwap aggregator routes on every pinned chain where Kyber is available: 1, 10, 56, 137, 146, 999, 4663, 8453, 42161, 43114, 59144, and 80094. Each chain uses its pinned router, Li.Fi diamond, and wrapped native. The builder refuses a disabled chain, an unknown router, a recipient that is not the treasury, and a route that does not match the build.
- Name the provision tarball from `package/package.json` inside the staged tarball, after the checksum. The installed tree and the working directory are not used. A bad version, or a filename `evalanche-<other>.tgz` that disagrees with that version, is refused before npm. As root, `EVALANCHE_BOX_TARBALL` is ignored. This rc pins `evalanche-1.17.0-rc.7.tgz`. `start` does not need package.json.
- Price a chain from CoinGecko `simple/price` when `price.priceFeed` is `coingecko`. The only URL is `https://api.coingecko.com/api/v3/simple/price`. A feed price must sit inside `price.bounds` or within 50% of a positive static price, and it fails closed otherwise. Redirects are refused. Static prices stay valid when the feed is off.
- Restore resolves each configured signer directory once. A symlink is allowed only when its target is a strict ancestor of one of those directories, so `/home/box/agent-data` may be a symlink. A symlink inside that resolved root, and any symlink in the escrow directory, is still refused.
- `--min-approval-nonce` applies only to wallet `lastNonce`. Repeatable `--min-tx-nonce CHAIN=N` applies only to that chain's transaction nonce. `--min-nonce` is removed. A missing floor is still refused. `--floor` must be a nonce state file with at least one approval or transaction nonce.
- Restore reads the manifest and each source once from an `O_NOFOLLOW` descriptor, then checks and writes those same bytes. A held `nonces.json.lock` is a running signer. An audit log that is shorter or older than the current one is refused. FIFOs and other non-regular files are refused.

## Upgrade

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.7.tgz`. Leave the rc.1, rc.2, rc.3, rc.4, rc.5, and rc.6 pins in place.
- Run `escrow` before a box reset. After the reset, `restore` creates the signer account. Pass `--min-approval-nonce` and one `--min-tx-nonce CHAIN=N` per chain when the current nonce file is gone, or pass a `--floor` nonce state file outside the escrow directory. Then run `provision` and `start`.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. The escrow manifest is a corruption check, not a tamper seal. pUSD approvals stay on the Polymarket module. See `docs/signer-multichain.md` and `docs/deploy/grok-bot-box.md`.
