# Evalanche v1.17.0-rc.8 — CCTP V2 Avalanche ↔ Base

Release candidate, 1 November 2026. This rc is not deployed. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, `evalanche-1.17.0-rc.5.tgz`, `evalanche-1.17.0-rc.6.tgz`, and `evalanche-1.17.0-rc.7.tgz` in place.

## Highlights

- Provision `evalanche-1.17.0-rc.8.tgz` as a new pin. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, `evalanche-1.17.0-rc.5.tgz`, `evalanche-1.17.0-rc.6.tgz`, and `evalanche-1.17.0-rc.7.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
- CCTP V2 adds Base 8453 (domain 6), treasury to treasury. Avalanche and Base may burn their native USDC with an exact approval to TokenMessengerV2, and Avalanche, Base and Polygon may receive. `mintRecipient` and the burn caller must be the treasury, `destinationCaller` is zero unless pinned, finality is 2000, `maxFee` defaults to 0, and hooks are denied. Base native USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Chains and domains are the `CCTP_CHAINS` table. Arbitrum 42161 (domain 3) is listed but disabled. Each burning chain has a code-level `allowedDestinationDomains`: Base burns only to Avalanche 1, and Avalanche keeps 6 and 7. A config outside that ceiling fails startup, and such a burn is denied at request time.
- `sourceDomains` must list enabled chains that can burn (Avalanche 1, Base 6). Polygon 7 can no longer be a source. A domain on Circle's list but not in the table, such as 0, now fails startup.
- `buildCctpBurn` requires an explicit `destinationDomain`. The Avalanche to Polygon default is removed.
- Attested mainnet Standard messages read from Iris on 1 November 2026 carry `expirationBlock` 0 in both directions. They are test vectors. The expiry rule is unchanged.

## Upgrade

- `provision` reads the version from the staged tarball's `package/package.json` after the sha256 check and pins `evalanche-<version>.tgz`. For this package that file is `evalanche-1.17.0-rc.8.tgz`. Leave the rc.1 through rc.7 pins in place.
- CCTP stays off until config enables it. Enabling Avalanche ↔ Base needs a separate config change and verifier update. No current config key changes meaning, but a config that lists Polygon 7 in `sourceDomains`, a domain outside the table, or a Base burn destination other than 1 now fails startup.

## Notes

Ed25519 verifier approvals, JCS intent hashes, and the nonce high-water mark are unchanged. Version 1.17.0 on npm is unaffected; this rc is a box signer pin only. See `docs/signer-multichain.md` and `docs/deploy/grok-bot-box.md`.
