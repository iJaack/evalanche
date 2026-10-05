# Evalanche Gaps

Historical resolved items are in [the archive](docs/archive/GAPS_history.md).

## Open gaps

- **2026-09-07 — A2A execution:** PR #10 accepts invalid credentials and uses a nonstandard task protocol. Status: reviewed and excluded from v1.13.0. End state: verified authentication, explicit capability policy and independent-client interoperability. [Evidence and acceptance criteria](docs/reviews/A2A_PR10_REVIEW.md).
- **2026-09-07 — Upstream dependency maintenance:** v1.14.0 removes the dYdX/Cosmos and legacy Avalanche Core/HPKE trees. Status: repository and clean consumer production audits report zero findings; deterministic signing, serialization, package, and read-only provider checks pass. End state: continue routine dependency review as upstream Avalanche SDK releases mature.
- **2026-09-07 — Funded execution certification:** public reads and quotes are automated; current trade, bridge and vault transaction receipts are outside this release. End state: separately authorized, minimal funded checks with transaction/order reconciliation per [runbook](docs/live-smoke-checklist.md).
