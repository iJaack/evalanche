# Evalanche v1.13.0 — Reliability and dependency hardening

## Highlights

- Fix vault holdings conversion failures: preserve verified shares, omit unavailable underlying assets, emit a warning and lower confidence until conversion recovers.
- Run SDK tests, type checking, builds, docs parity, package validation and audit gates on pull requests and main pushes. Bound test workers to reduce CPU contention without increasing assertion timeouts.
- Add bounded live read compatibility checks for Avalanche, Robinhood Chain, Hyperliquid, Polymarket and LI.FI quotes, with timestamped commit-linked evidence and a daily workflow.
- Update axios, protobufjs, tiny-secp256k1, Hyperliquid, valibot, Vite, follow-redirects and @protobufjs/utf8; remove unused direct dependencies and make dYdX optional. The production audit baseline is now zero critical and zero high findings.
- Publish an explicit security-overrides.json recipe for consumer roots. Validate plain and configured full/omit-optional consumer installations, ESM/CJS exports, wallet construction and dYdX protobuf compatibility from the tarball.
- Keep Avalanche Core genuinely lazy in the built SDK, preventing Ledger import failures from breaking ordinary EVM startup, and repair CommonJS module resolution for lazy SDK loaders.
- Reject incomplete audit reports and new high/critical advisory IDs even if package counts stay unchanged.
- Review A2A PR #10 with a local client/server reproduction. Keep it unmerged because credential verification is absent and its custom task protocol does not interoperate with standard A2A requests.

## Install

```sh
npm install evalanche@1.13.0
# Optional dYdX integration can be omitted:
npm install evalanche@1.13.0 --omit=optional
```

The standard install retains dYdX. Calls to dYdX require its optional SDK; other surfaces remain available when it is omitted. Avalanche Core remains required for compatibility with the existing X/P-chain integration.

## Dependency policy

npm ignores a dependency's own overrides. The zero high/critical baseline applies to this repository and consumer projects configured with the shipped `security-overrides.json` recipe. **A plain npm install still inherits upstream advisories.** Merge the recipe into your application's root `package.json` overrides, resolve conflicts deliberately, reinstall and audit. The release includes separate plain/configured consumer results. See the README for exact commands.

The audit still reports low/moderate findings in upstream integrations. Zero high/critical audit findings is not a claim of exploit-free code or a complete security audit. See `docs/security/DEPENDENCY_REVIEW_1.13.0.md` for the scope.

## Validation and limitations

The release workflow runs the full unit/regression suite, typecheck, build, deterministic smoke, fresh consumer installs and live read checks before publication. Machine-readable results are attached to the GitHub release.

Live checks perform public reads and quote construction only. No wallet-funded trade, bridge, signature or contract write is certified by this release. Native A2A task execution is not included; the review and replacement acceptance criteria are in `docs/reviews/A2A_PR10_REVIEW.md`.
