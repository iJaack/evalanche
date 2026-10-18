# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.16.0](docs/releases/RELEASE_NOTES_1.16.0.md)
- Shipped in `v1.16.0`:
  - Add a per-chain signer policy for the nineteen mainnets. Avalanche 43114 stays on unless `enabled` is false or `killSwitch` is true. Every other chain stays off until `enabled` is true. Testnets cannot be enabled. An old file with no `chains` object keeps its chain list, shared token caps, gas cap, price source, and Avalanche slippage defaults.
  - Price each chain from its own `price.prices` or `price.sanitySource`. The global price map is not applied once `chains` is set. An enabled chain must have a native cap, a cap for every allowlisted token, a positive `gas.maxFeeUsd`, and a native price or HTTPS feed. Address-keyed `tokenCaps` are not copied onto those chains. The native wei gas cap remains.
  - Allow CTF `setApprovalForAll` to a current V2 exchange with `approved` false, and `pauseUser()` on the standard and neg-risk V2 exchanges, as kill switches. `unpauseUser` and admin `pauseTrading` stay denied.
  - Stop adding the ERC-20 `transfer` selector when the Avalanche LP module is enabled. A transfer selector already in the allow map stays. The position manager is module-handled only while that module is on. A zero approve to the position manager is allowed so an allowance can be revoked. `MaxUint256` stays denied.

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
