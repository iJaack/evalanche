# Vulnerability Notes

This file is a short current-state security posture note, not a historical remediation log.

<!-- GENERATED:vuln-snapshot:start -->
## Current Release Snapshot

- Current release: `1.9.7`
- `npm audit --omit=dev`: `5 critical`, `4 high`, `12 low`

## Active Overrides

- `@ledgerhq/cryptoassets`: `9.13.0`
- `@hpke/core`: `^1.9.0`
- `axios`: `1.13.6`
- `@osmonauts/lcd.axios`: `^1.13.6`
<!-- GENERATED:vuln-snapshot:end -->

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
