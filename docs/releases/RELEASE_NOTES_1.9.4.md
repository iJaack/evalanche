## Highlights

- Hardened MCP HTTP mode so it requires an explicit bearer token, binds to loopback by default, enforces request timeouts, and rejects oversized request bodies.
- Routed high-risk helper execution through the active spending policy, including generic approve-and-call, UUPS proxy upgrade, Li.Fi bridge/swap execution, and Gas.zip funding.
- Made MCP policy removal explicit with `remove=true` and `confirm="remove"` instead of treating an empty policy payload as removal.
- Changed x402 service hosting so paid endpoints require a settlement verifier by default, while preserving explicit `signed-intent` mode for trusted peer demos and tests.
- Added an adversarial threat model documenting resolved threats, residual risks, and focus paths for future AppSec review.

## Validation

- `npm run typecheck`
- `npm run test -- test/mcp/server.test.ts test/economy/service.test.ts`
- `npm run test`
- `npm run build`

## Notes

- HTTP MCP users must now set `EVALANCHE_MCP_HTTP_TOKEN` or pass `startHTTP({ authToken })`.
- `v1.9.3` was intentionally skipped; `v1.9.4` is the next published patch after `v1.9.2`.
- Remaining follow-up work is tracked in the updated threat model: scoped MCP tokens, production x402 settlement verifier adapters, semantic quote invariant checks, and dependency reachability triage.
