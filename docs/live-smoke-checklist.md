# Evalanche Live Smoke and Report-Closure Checklist

Use this runbook before cutting an execution-facing release. The goal is to confirm that the real venue or protocol still behaves the way the automated test suite expects.

## Rules

- Use a dedicated funded hot wallet with minimal balances.
- Prefer preview or tiny notional trades.
- Do not reuse historical output as proof; rerun the checks on the target release commit.
- Record tx hashes, order IDs, and reconciliation output for each surface.

## 1. Polymarket

### Runtime prerequisites
- The official `polymarket` CLI is installed and pinned, or `EVALANCHE_POLYMARKET_CLI_BIN` points at the intended binary.
- `polymarket -o json markets list --limit 1` returns valid JSON before any wallet-backed write check.
- The hot wallet signer is available only through the intended Evalanche/OpenClaw secret path; do not pass the private key in command arguments.

### Read checks
- `pm_search` returns the expected market.
- `pm_market` returns outcome tokens.
- `pm_orderbook` returns bids and asks for the selected outcome.
- `pm_balances` shows normalized human USDC values plus raw venue values.

### Write checks
- `pm_preflight` succeeds for a tiny buy or sell.
- `pm_buy` or `pm_limit_sell` returns `request`, `submission`, `verification`, and `warnings`.
- `pm_order` confirms venue order status.
- `pm_reconcile` confirms the resulting position delta or resting-order state.
- `pm_cancel_order` successfully cancels a resting order if one was created.

## 2. Hyperliquid

### Read checks
- `hyperliquid_get_markets` returns the target market.
- `hyperliquid_get_account_state` returns account margin data for the wallet.
- `hyperliquid_get_positions` returns existing positions, including the empty-account case.

### Write checks
- `hyperliquid_place_limit_order` returns `request`, `submission`, `verification`, and `warnings`.
- `hyperliquid_get_order` confirms the order status.
- `hyperliquid_cancel_order` cancels the order cleanly.
- `hyperliquid_place_market_order` or `hyperliquid_close_position` confirms fills or flat position state through `hyperliquid_get_positions` and `hyperliquid_get_trades`.

## 3. LI.FI

### Quote checks
- `lifi_swap_quote` succeeds for a tiny same-chain route.
- `get_bridge_quote` or `get_bridge_routes` succeeds for a tiny bridge route.
- Route-strategy inputs survive quoting without malformed payloads.

### Execution checks
- `lifi_swap` returns `request`, `submission`, `verification`, and `warnings`.
- `verification` includes a source receipt status and, when applicable, transfer status.
- Cross-chain execution confirms final transfer state with `check_bridge_status`.
- If balance verification is available on the current provider, record the before/after token deltas.

## 4. Yield / Vaults

### Liquid staking checks
- `savax_stake_quote` succeeds for a tiny AVAX amount and reports `resolution.network = avalanche` when routed through MCP.
- `savax_unstake_quote` succeeds on Avalanche and reports whether the path is instant or delayed.
- Calling `savax_*` on a non-Avalanche explicit network fails immediately with a wrong-chain style error instead of a generic revert.

### Vault checks
- `vault_info` auto-routes known vaults such as yoUSD to Base when the caller omits a network.
- `vault_deposit_quote` and `vault_withdraw_quote` succeed for a tiny amount without manual network switching for known vaults.
- Explicit wrong-chain vault calls fail clearly instead of surfacing opaque decode noise.
- If funding is available, execute a tiny deposit and withdraw and confirm resulting balances or shares.

### Resolution checks
- Interoperable address inputs like `0x...@base` resolve to the expected chain.
- Avalanche protocols can resolve through the vendored AvaPilot-backed registry snapshot without live network access.
- Local canonical mappings override external/provider mappings when they disagree.

## Report-closure matrix

Record each report claim as one of:
- `fixed in code`
- `covered by regression`
- `manually revalidated live`

Use this minimum mapping before closing an execution-readiness report:
- yoUSD wrong-chain MCP failure: fixed via canonical Base routing, regression covered, then live-checked with `vault_info` and `vault_deposit_quote`
- sAVAX wrong-chain MCP failure: fixed via canonical Avalanche routing, regression covered, then live-checked with `savax_stake_quote` and `savax_unstake_quote`
- Polymarket stale local assumption risk: fixed via venue-truth balances and reconciliation, regression covered, then live-checked with `pm_preflight`, `pm_order`, and `pm_reconcile`
- Polymarket CLI substitution risk: fixed via pinned CLI path, JSON-only smoke, and no argv secrets before wallet-backed Polymarket checks
- Hyperliquid uncertified write path: MCP verification envelope covered by regression, then live-checked with tiny limit/market flows
- LI.FI uncertified execution path: MCP verification envelope covered by regression, then live-checked with tiny swap/bridge flows

## Release gate

Do not ship if any of these fail:
- a write path returns an ad hoc response shape instead of the expected envelope
- venue or protocol verification disagrees with the local submission result
- a previously fixed bug reproduces without a failing automated test
- the report-closure matrix still has any in-scope claim without regression coverage
