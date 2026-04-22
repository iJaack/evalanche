## Highlights

- Added macOS Keychain fallback for agent credentials, so Mony and other local agents can resolve the `EvaWallet` / `EvaMain` sovereign wallet after OpenClaw secrets and env vars and before the encrypted keystore path
- Made Polymarket orderbook handling deterministic by sorting visible bids highest-first and asks lowest-first before pricing, preflight, and sell-fill estimation
- Preserved the `v1.9.0` Polymarket withdrawal flow while promoting the Mony-tested Evalanche runtime fixes into the public release line
- Added focused regression coverage for keychain credential resolution and unsorted CLOB orderbook arrays
- Added the standalone Evalanche website app and configured the Vercel website output path independently from the SDK package build
- Covered deps and deps-dev bump updates for Vite from `8.0.1` to `8.0.7` and Picomatch from `4.0.3` to `4.0.4`

## Validation

- `npm test -- test/secrets.test.ts test/polymarket/client-extended.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Notes

- `v1.9.1` was intentionally skipped; `v1.9.2` is the next published patch after `v1.9.0`
- The Keychain fallback is macOS-only and uses service `EvaWallet`, account `EvaMain`
- No MCP tool schemas or CLI flags changed in this release
