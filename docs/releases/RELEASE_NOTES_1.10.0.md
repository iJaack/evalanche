## Highlights

- Switched Polymarket buy execution onto the current CLOB v2 path so live order submission works against the latest venue order format instead of failing on legacy order-version rejections.
- Added explicit Polygon / Polymarket collateral handling improvements around CLOB funding, venue reconciliation, and chain/network mapping needed for current Polymarket execution flows.
- Expanded Polymarket MCP coverage with updated buy-path tests, geoblock envelope handling, v2 order behavior, and refreshed chain expectations.

## Validation

- `npm test`
- `npm run typecheck`
- `npm run build`

## Notes

- `@polymarket/clob-client` is now pinned at `^5.8.1` and `@polymarket/clob-client-v2` is included for the active execution path.
- Market buys on the v2 path no longer rely on caller-supplied manual nonces; limit orders still carry explicit high nonces where required.
- This is the first public minor release line carrying the working Polymarket v2 execution path for current venue behavior: `v1.10.0`.
