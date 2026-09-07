# Evalanche Gaps

Historical resolved items are in [the archive](docs/archive/GAPS_history.md).

## Open gaps

- **2026-09-07 — A2A execution:** PR #10 accepts invalid credentials and uses a nonstandard task protocol. Status: reviewed and excluded from v1.13.0. End state: verified authentication, explicit capability policy and independent-client interoperability. [Evidence and acceptance criteria](docs/reviews/A2A_PR10_REVIEW.md).
- **2026-09-07 — Upstream dependency maintenance:** plain consumer installs still inherit vulnerable upstream pins; the hardened override recipe retains low/moderate findings in legacy Cosmos/Avalanche/Ledger trees. Status: high/critical findings removed from configured npm resolutions; additional reachability review remains open. End state: maintained compatible dependencies with serialization/signing and fresh consumer audit proof.
- **2026-09-07 — Funded execution certification:** public reads and quotes are automated; current trade, bridge and vault transaction receipts are outside this release. End state: separately authorized, minimal funded checks with transaction/order reconciliation per [runbook](docs/live-smoke-checklist.md).
