## Highlights

- Hardened MCP HTTP mode so it now requires an explicit bearer token, binds to loopback by default, enforces request timeouts, and rejects oversized request bodies before parsing.
- Routed high-risk execution helpers through active spending-policy checks, including approve-and-call, UUPS proxy upgrades, Li.Fi bridge/swap execution, and Gas.zip funding.
- Tightened x402 paid-service hosting so settled endpoints require a settlement verifier by default, while preserving explicit `signed-intent` mode for trusted peer flows and tests.
- Fixed Polymarket collateral normalization for live pUSD spender allowances, and made `pm_approve` / `pm_deposit` sync both wallet USDC.e -> CLOB approval and Polygon pUSD spender approvals.

## Validation

- `npm test`
- `npm run typecheck`
- `npm run build`

## Notes

- HTTP MCP users must now set `EVALANCHE_MCP_HTTP_TOKEN` or pass `startHTTP({ authToken })`.
- Polymarket venue balance reads now prefer live pUSD spender approvals over the stale single-allowance assumption, with wallet-side USDC.e -> CLOB approval retained as fallback.
- This release folds the previously prepared 1.9.4/1.9.5 hardening work together with the pending Polymarket allowance fix into one clean public release line: `v1.9.7`.
