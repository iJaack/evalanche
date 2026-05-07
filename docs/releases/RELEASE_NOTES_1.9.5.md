## Highlights

- Fixed Li.Fi EVM quote normalization so Base → Polygon USDC bridge requests strip CAIP-10 `eip155:<chain>:` prefixes before sending `fromAddress` / `toAddress` to Li.Fi.
- Added regression coverage for Base → Polygon native USDC quote construction, matching Mony’s Polymarket buffer top-up path.

## Validation

- `npm test -- test/bridge/lifi.test.ts`
- `npm run typecheck`
- `npm run build`
- live bridge quote smoke: Base USDC → Polygon native USDC with CAIP-10 `fromAddress`

## Notes

- This unblocks autonomous Polymarket cash-buffer top-ups where the wallet needs to bridge small Base USDC balances onto Polygon before PM collateral conversion.
- Scope is intentionally narrow: quote address normalization only, with no behavior change for already-flat EVM addresses.
