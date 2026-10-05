# Evalanche v1.14.0 — Avalanche SDK and L1 hardening

## Highlights

- Make Avalanche the hardened default with the official `@avalanche-sdk/client`, removing the legacy Core wallet and vulnerable HPKE dependency trees from fresh consumer installs.
- Expand Avalanche L1 support with live mainnet and Fuji catalog discovery, RPC chain ID verification, native-token preservation, and public SDK/MCP helpers.
- Remove the dYdX SDK, exports, MCP tools, holdings detector, and transitive Cosmos dependencies; Hyperliquid remains the supported perpetuals integration.
- Harden X/P/C address routing, offline signing, atomic import/export polling, network switching, HTTP cancellation, response limits, audit parsing, and release automation.
- Require Node.js 20 or newer and pin `@scure/bip32@1.7.0` because Avalanche SDK 0.1.3 imports it without declaring the runtime dependency.

## Install

```sh
npm install evalanche@1.14.0
```

Avalanche remains the default network. Fresh plain, configured, and `--omit=optional` consumer installs must all report zero production vulnerabilities and must not resolve Core, HPKE, or dYdX packages.

## Migration requirements

This maintainer-directed minor release includes compatibility changes that consumers must review:

- The runtime floor moves from Node.js 18 to Node.js 20.
- dYdX APIs and MCP tools are removed. Use Hyperliquid for perpetuals.
- X/P/C implementation types from the legacy Core SDK are no longer part of the package surface. Evalanche's documented X/P/C methods remain available through the new adapter.
- Avalanche L1 wallets are EVM-only. X/P-chain signing remains scoped to Avalanche C-Chain and Fuji.

## Security

The Core dependency chain pinned `@hpke/core@1.2.5`, affected by CVE-2025-64767 / GHSA-73g8-5h73-26h4. No matching concurrent sender-context exploit was found in Evalanche's observed flow, but v1.14.0 removes the vulnerable dependency instead of relying on consumer root overrides.

Repository and clean consumer production audits report zero vulnerabilities at every severity. The remaining override recipe covers unrelated transitive compatibility pins and is validated against the installed tree.

## Validation and limitations

- 589 tests across 50 files, type checking, ESM/CJS/DTS builds, package validation, and documentation parity passed locally.
- The packed tarball passed plain, configured, and `--omit=optional` clean installs, ESM/CJS loading, deterministic X/P derivation, offline signing, and dependency-absence checks.
- Live read-only checks passed for Avalanche, Fuji, Robinhood Chain, Hyperliquid, Polymarket, and LI.FI quote construction.
- No funded X/P/C transaction or other value-bearing action was broadcast. Transaction construction, routing, and signing were verified offline or with mocked RPC; live checks were read-only.
