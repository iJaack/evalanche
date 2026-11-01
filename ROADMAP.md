# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.17.0-rc.8](docs/releases/RELEASE_NOTES_1.17.0-rc.8.md)
- Shipped in `v1.17.0-rc.8`:
  - Provision `evalanche-1.17.0-rc.8.tgz` as a new pin. Leave `evalanche-1.17.0-rc.1.tgz`, `evalanche-1.17.0-rc.2.tgz`, `evalanche-1.17.0-rc.3.tgz`, `evalanche-1.17.0-rc.4.tgz`, `evalanche-1.17.0-rc.5.tgz`, `evalanche-1.17.0-rc.6.tgz`, and `evalanche-1.17.0-rc.7.tgz` in place. Provisioning again under one of those filenames would overwrite a rollback pin.
  - CCTP V2 adds Base 8453 (domain 6), treasury to treasury. Avalanche and Base may burn their native USDC with an exact approval to TokenMessengerV2, and Avalanche, Base and Polygon may receive. `mintRecipient` and the burn caller must be the treasury, `destinationCaller` is zero unless pinned, finality is 2000, `maxFee` defaults to 0, and hooks are denied. Base native USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
  - Chains and domains are the `CCTP_CHAINS` table. Arbitrum 42161 (domain 3) is listed but disabled. Each burning chain has a code-level `allowedDestinationDomains`: Base burns only to Avalanche 1, and Avalanche keeps 6 and 7. A config outside that ceiling fails startup, and such a burn is denied at request time.
  - `sourceDomains` must list enabled chains that can burn (Avalanche 1, Base 6). Polygon 7 can no longer be a source. A domain on Circle's list but not in the table, such as 0, now fails startup.

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
