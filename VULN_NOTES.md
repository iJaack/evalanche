# Vulnerability Notes

This file is a short current-state security posture note, not a historical remediation log.

<!-- GENERATED:vuln-snapshot:start -->
## Current Release Snapshot

- Current release: `1.14.0`
- `npm audit --omit=dev` (repository overrides): `0 critical`, `0 high`, `0 moderate`, `0 low`

## Active Overrides

- `axios`: `1.20.0`
- `form-data`: `4.0.6`
- `ws`: `8.21.0`
- `@protobufjs/utf8`: `1.1.2`
- `follow-redirects`: `1.16.0`
- `protobufjs`: `7.6.6`
- `valibot`: `1.4.2`
- `tiny-secp256k1`: `1.1.7`
<!-- GENERATED:vuln-snapshot:end -->

These counts apply to the repository and are independently checked in plain, configured, and `--omit=optional` clean consumer installs. Consult the separate consumer audit assets attached to the GitHub release.

## Current Posture

- keep dependency overrides explicit and current
- track vulnerability reachability, not only raw advisory counts
- prefer isolating optional heavy integrations over carrying risky trees in the main runtime path

## Current Watch Areas

- pre-1.0 Avalanche SDK API and dependency changes
- the direct `@scure/bip32` compatibility pin required by Avalanche SDK 0.1.3
- multi-client trees that duplicate shared HTTP dependencies like `axios`

## Expected Maintenance

- review dependency changes during release prep
- keep override policy aligned with the installed tree
- update this note when the current risk picture materially changes

## Avalanche dependency remediation — v1.14.0

- Remove dYdX and its Cosmos dependency tree.
- Replace the legacy Core wallet tree with `@avalanche-sdk/client`, eliminating the affected HPKE and Ledger dependency paths.
- Require every repository and clean consumer production audit to report complete, internally consistent counts with zero findings at every severity.
- Preserve deterministic X/P derivation and offline signing with dedicated package and adapter regressions.
