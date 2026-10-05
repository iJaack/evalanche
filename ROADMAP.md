# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.14.0](docs/releases/RELEASE_NOTES_1.14.0.md)
- Shipped in `v1.14.0`:
  - Make Avalanche the hardened default with the official `@avalanche-sdk/client`, removing the legacy Core wallet and vulnerable HPKE dependency trees from fresh consumer installs.
  - Expand Avalanche L1 support with live mainnet and Fuji catalog discovery, RPC chain ID verification, native-token preservation, and public SDK/MCP helpers.
  - Remove the dYdX SDK, exports, MCP tools, holdings detector, and transitive Cosmos dependencies; Hyperliquid remains the supported perpetuals integration.
  - Harden X/P/C address routing, offline signing, atomic import/export polling, network switching, HTTP cancellation, response limits, audit parsing, and release automation.

## Current Focus

<!-- GENERATED:roadmap-release:end -->

## Milestone 1: SDK reliability — implemented in v1.13.0

- Run tests, typecheck, build, docs/exports/tarball checks and dependency audits on PRs and main.
- Preserve vault shares when underlying conversion fails, with an unavailable value and explicit warning.
- Bound test concurrency without relaxing test timeouts.
- Completion check: full unit/regression suite, vault failure/recovery regression and release gates pass.

## Milestone 2: Dependency and provider verification — implemented in v1.13.0

- Remove unused direct dependencies, make dYdX optional and update vulnerable transitive packages.
- Ship a reviewed consumer override recipe and validate plain and configured full/omit-optional installs.
- Reject failed audit requests and newly introduced high/critical advisory IDs.
- Run bounded public RPC, market and LI.FI quote checks daily and at release time; retain timestamped evidence.
- Completion check: installed SDK serialization regression, audit-error regression, real HTTP timeout/schema tests, consumer audits and live read checks pass.

## Milestone 3: A2A interoperability — reviewed, blocked

- Review PR #10 against its exact contribution commit and reproduce a local client/server exchange.
- Authentication bypass and nonstandard transport were reproduced; see [review](docs/reviews/A2A_PR10_REVIEW.md).
- Next implementation: select a supported A2A version, verify credentials, default to loopback, enforce capability authorization and bound task/request resources.
- Completion check: unit/regression tests for malformed input, invalid credentials and cancellation plus successful exchange with an independent standard client. Do not merge or advertise native A2A execution until these pass.

## Following milestones

- Unreleased reliability hardening: keep SDK HTTP deadlines active through body reads, honor caller cancellation, release oversized response readers and reject invalid resource limits. Reject malformed or inconsistent audit reports in repository and consumer gates. Validation requires real HTTP regressions, the full SDK suite and release package checks.

- Add one canonical Avalanche detector at a time with positive, zero-balance, failure and wrong-chain fixtures. Completion requires a current read-only onchain comparison.
- Shipped Avalanche expansion in v1.14.0: migrate native X/P/C operations to the official Avalanche SDK, remove dYdX and legacy Core/HPKE dependencies, discover public mainnet/Fuji EVM L1s, verify RPC chain IDs, preserve native tokens, and retain wallet policies/budgets across network switches.
- Replace remaining deprecated cryptographic dependency paths only with verified API compatibility. Completion requires signing/serialization regressions and consumer audit evidence.
- Certify execution-facing venue changes using the [live smoke checklist](docs/live-smoke-checklist.md). Reads and quotes do not certify funded execution.

## Working Rules

- keep one active roadmap
- keep release notes out of the repo root
- prefer shipped, testable value over speculative architecture
- update this file when priorities change materially
