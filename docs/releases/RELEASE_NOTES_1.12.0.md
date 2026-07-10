## Highlights

- Adds first-class Robinhood Chain mainnet support through the named `robinhood` network alias and chain ID `4663`, with official ETH, RPC, explorer, and LI.FI metadata.
- Extends wallet boot, network switching, MCP chain discovery and switching, and native holdings scans to Robinhood Chain through Evalanche's central EVM registry.
- Preserves the Robinhood network with RPC overrides supplied through `ROBINHOOD_RPC_URLS`, `EVALANCHE_ROBINHOOD_RPC_URLS`, and MCP `AVALANCHE_RPC_URL`, keeping the selected network alias authoritative.
- Tests certify Robinhood bridge capabilities through LI.FI native ETH quote construction and prevent non-Gas.zip routes from being mislabeled as Gas.zip.
- Rejects Gas.zip requests involving Robinhood Chain before network access while LI.FI's live `gasZipBridge` capability matrix excludes chain `4663`.
- Scopes MCP RPC overrides to their selected network so switching chains cannot retain a stale wrong-chain provider.
- Pins patched `form-data` and `ws` transitive releases, clearing the newly disclosed advisories without increasing the accepted production-audit baseline.
- Pin the release workflow npm version to `11.12.1`, the supported npm line for its Node.js 20 runtime.

## Validation

- `npm run test -- test/chains.test.ts test/utils/robinhood-network.test.ts test/agent.test.ts test/holdings/client.test.ts test/mcp/cli.test.ts test/mcp/server.test.ts`
- `npm run test -- test/bridge/lifi.test.ts test/bridge/gaszip.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- Read-only `eth_chainId` check against the official Robinhood Chain RPC returned `0x1237` (`4663`).
- Read-only LI.FI quote from Ethereum to Robinhood Chain returned an Across route with destination chain `4663`.
- Read-only LI.FI tool discovery reported zero Gas.zip pairs involving chain `4663`.

## Notes

- This release supports Robinhood Chain mainnet only. Robinhood Chain Testnet (`46630`) is intentionally not registered.
- Robinhood's public RPC is rate-limited; production deployments should configure provider endpoints through the documented override variables.
- LI.FI bridge liquidity and route availability remain live vendor state rather than a permanent SDK guarantee.
- Gas.zip remains unavailable for Robinhood Chain until its advertised capability matrix includes chain `4663`; Evalanche fails safely and explicitly in the meantime.
- All live verification for this release was read-only and quote-only. No bridge, gas-funding, transfer, or contract transaction was broadcast.
