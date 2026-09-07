# Dependency review — v1.13.0

## Changes

Production audit before changes: 1 critical, 13 high, 9 moderate, 12 low. After the tested updates: 0 critical, 0 high, 5 moderate, 23 low (2026-09-07 snapshot; future advisories may change these counts).

- axios 1.20.0 replaces 1.13.6 across the tree.
- protobufjs 7.6.6 replaces affected 6.x/8.0.0 resolutions. The real dYdX SDK load and OrderId encode/decode round-trip are regression tested; this does not certify every upstream codec or live order path.
- tiny-secp256k1 1.1.7 patches the bundled-environment verification/signing advisories without an API-major change.
- Hyperliquid 0.33.3 and valibot 1.4.2 update the typed integration and its validation dependency.
- follow-redirects 1.16.0 and @protobufjs/utf8 1.1.2 incorporate/supersede dependency PRs #11 and #13; Vite 8.2.2 supersedes PR #19.
- Unused direct avalanchejs, core-utils-sdk and big.js declarations are removed. Avalanche Core retains the actual required transitives.
- dYdX is an optional dependency. A default install retains it; callers may omit it when unused. Avalanche Core stays required because optionalizing its engine-restricted transitive tree can silently remove the integration on newer Node versions.

## Reachability and remaining risk

The protobuf code-execution advisory requires attacker-controlled schemas; Evalanche uses the SDK's fixed generated schemas. This review does not establish a remote exploit path in Evalanche. Patched serialization is tested nonetheless.

The tiny-secp256k1 findings concern the bundled fallback used by Bitcoin/HD-key transitives. Evalanche primarily uses EVM wallets and Avalanche signing, but the installed dependency tree contained affected code. A patch-level update avoids treating an unproven reachability assumption as a permanent exception.

Deprecated Cosmos cryptography and Avalanche/Ledger dependencies still produce low/moderate findings. The full SDK has not received a new exhaustive security audit. Live reads do not exercise cryptographic signing or funded writes.

## Consumer evidence

npm ignores a dependency's own overrides. Fresh plain installs still inherit upstream vulnerable pins; the GitHub release attaches their actual counts separately. A shrinkwrap trial did not preserve the required versions and was removed.

The supported hardened setup merges the shipped `security-overrides.json` into the application root, with review of conflicts. Clean full and omit-optional installs with that recipe must have zero high/critical audit findings and pass runtime compatibility checks. This is an explicit consumer configuration requirement, not an automatically secure default install.

Bundling previously hoisted Core's static imports into ESM startup and exposed ordinary EVM users to a Ledger module import failure. The lazy loader now loads Core only when X/P-chain operations request it, using module-relative resolution in both ESM and CommonJS.

## References

- https://github.com/advisories/GHSA-xq3m-2v4x-88gg
- https://github.com/advisories/GHSA-5vhg-9xg4-cv9m
- https://github.com/advisories/GHSA-7mc2-6phr-23xc
- https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides
- https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/
