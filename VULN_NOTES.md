# Vulnerability Notes

This file is a short current-state security posture note, not a historical remediation log.

<!-- GENERATED:vuln-snapshot:start -->
## Current Release Snapshot

- Current release: `1.13.0`
- `npm audit --omit=dev` (repository overrides): `0 critical`, `0 high`, `5 moderate`, `23 low`

## Active Overrides

- `@ledgerhq/cryptoassets`: `9.13.0`
- `@hpke/core`: `^1.9.0`
- `axios`: `1.20.0`
- `form-data`: `4.0.6`
- `ws`: `8.21.0`
- `@cosmjs/socket.ws`: `7.5.11`
- `@protobufjs/utf8`: `1.1.2`
- `follow-redirects`: `1.16.0`
- `protobufjs`: `7.6.6`
- `valibot`: `1.4.2`
- `tiny-secp256k1`: `1.1.7`
<!-- GENERATED:vuln-snapshot:end -->

These counts apply to the repository override policy. Plain consumer installs still inherit upstream advisories. Use the shipped `security-overrides.json` at the application root and consult the separate configured/plain consumer audit assets on the GitHub release.

## Current Posture

- keep dependency overrides explicit and current
- track vulnerability reachability, not only raw advisory counts
- prefer isolating optional heavy integrations over carrying risky trees in the main runtime path

## Current Watch Areas

- Avalanche Core SDK dependency surface
- Ledger and hardware-wallet transitive paths
- multi-client trees that duplicate shared HTTP dependencies like `axios`

## Expected Maintenance

- review dependency changes during release prep
- keep override policy aligned with the installed tree
- update this note when the current risk picture materially changes
