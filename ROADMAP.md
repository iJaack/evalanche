# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.9.2](docs/releases/RELEASE_NOTES_1.9.2.md)
- Shipped in `v1.9.2`:
  - Added macOS Keychain fallback for agent credentials, so Mony and other local agents can resolve the `EvaWallet` / `EvaMain` sovereign wallet after OpenClaw secrets and env vars and before the encrypted keystore path
  - Made Polymarket orderbook handling deterministic by sorting visible bids highest-first and asks lowest-first before pricing, preflight, and sell-fill estimation
  - Preserved the `v1.9.0` Polymarket withdrawal flow while promoting the Mony-tested Evalanche runtime fixes into the public release line
  - Added focused regression coverage for keychain credential resolution and unsorted CLOB orderbook arrays

## Current Focus

- Avalanche-first execution quality
- Holdings coverage
- Interop and transport
- Security and dependency reduction
<!-- GENERATED:roadmap-release:end -->

## Near-Term Priorities

### 1. Avalanche-first execution quality

- keep Avalanche as the primary docs, examples, and user path
- expand canonical Avalanche app coverage
- improve execution and verification for Avalanche-native protocols

### 2. Holdings coverage

- grow the universal in-repo holdings registry
- expand protocol detectors and seeded sources
- reduce false negatives across DeFi positions and venue holdings

### 3. Interop and transport

- extend agent identity and interoperability support
- add stronger A2A-style task exchange patterns
- improve async transport and trust artifacts where they add real execution value

### 4. Security and dependency reduction

- keep optional integrations isolated
- reduce vulnerability reachability in heavy dependency trees
- maintain clear release and smoke-check discipline

## Working Rules

- keep one active roadmap
- keep release notes out of the repo root
- prefer shipped, testable value over speculative architecture
- update this file when priorities change materially
