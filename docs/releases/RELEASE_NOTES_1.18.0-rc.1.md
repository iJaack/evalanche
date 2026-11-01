# Evalanche v1.18.0-rc.1 (draft, unreleased)

This file collects notes for the Solana 1.18 work on `feat/solana-1.18`. Nothing here is released, and Solana signing stays disabled until the release that enables it.

## Tarball cap

- The npm tarball cap in `scripts/check-package-tarball.mjs` rises from 1,000,000 to 1,500,000 bytes.
- Why: the package is 994,531 bytes at 1.17.0-rc.8, about 5.5 KB under the old cap. The Solana work still to come (System, SPL Token, Token-2022, ATA and ComputeBudget decoders, the 2-of-2 RPC quorum, key custody and escrow, Jupiter v6) does not fit in that margin.
- The cap is still a hard gate. CI and the publish workflow fail above 1,500,000 bytes, and each Solana PR reports its size delta.
