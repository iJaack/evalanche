# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.12.0](docs/releases/RELEASE_NOTES_1.12.0.md)
- Shipped in `v1.12.0`:
  - Adds first-class Robinhood Chain mainnet support through the named `robinhood` network alias and chain ID `4663`, with official ETH, RPC, explorer, and LI.FI metadata.
  - Extends wallet boot, network switching, MCP chain discovery and switching, and native holdings scans to Robinhood Chain through Evalanche's central EVM registry.
  - Adds production RPC overrides through `ROBINHOOD_RPC_URLS`, `EVALANCHE_ROBINHOOD_RPC_URLS`, and MCP `AVALANCHE_RPC_URL` while keeping the selected network alias authoritative.
  - Certifies LI.FI native ETH quote construction for Robinhood Chain and prevents non-Gas.zip routes from being mislabeled as Gas.zip.

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
