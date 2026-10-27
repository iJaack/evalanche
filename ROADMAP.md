# Evalanche Roadmap

This is the active roadmap for the repository.

<!-- GENERATED:roadmap-release:start -->
## Latest Shipped Release

- Latest release: [v1.17.0](docs/releases/RELEASE_NOTES_1.17.0.md)
- Shipped in `v1.17.0`:
  - Add a pluggable signer so an agent can sign without a private key in the Evalanche process. `EvalancheConfig.signer` accepts a local ethers wallet, a `SigningProvider`, or a remote signer config. `EvalancheConfig.address` starts an address-only agent that cannot sign.
  - Add `evalanche-signer`, a reference signing server. It holds the key, checks a pinned Ed25519 verifier approval, recomputes the intent hash, and enforces a monotonic single-use nonce, expiry, a deny list, SpendingPolicy, token caps, and simulation. It binds to `127.0.0.1` or a unix socket and writes a hash-chained JSONL audit log. Dry-run never signs.
  - Let `evalanche-mcp` run keyless with `--signer-url` / `EVALANCHE_SIGNER_URL` and `--signer-address` / `EVALANCHE_SIGNER_ADDRESS`, or read-only with `EVALANCHE_ADDRESS`. Polymarket CLI and Avalanche X/P-chain paths fail with `REMOTE_SIGNER_UNSUPPORTED` in those modes and never fall back to an environment private key.
  - Add a per-chain signer policy for nineteen mainnets. Avalanche C-Chain stays on unless disabled. Every other chain, and every testnet, stays off until config enables it. Each enabled chain prices and caps itself.

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
