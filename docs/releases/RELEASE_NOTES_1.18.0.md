# Evalanche v1.18.0 — Withdraw3-only Hyperliquid signer support

This minor release builds on npm 1.17.0. The new signer feature is off by default. It does not include the unreleased CCTP V2 Avalanche <-> Base work from `release/1.17.0` (rc.8).

## Highlights

- Add an opt-in Hyperliquid withdraw3 signer path with a fixed treasury destination, exact SDK typed-data schema, and explicit verifier intent binding.
- Require a timestamp from five minutes ago through sixty seconds ahead and a fresh clearinghouseState read with no open positions and sufficient withdrawable balance.
- Persist Hyperliquid timestamps in a separate durable nonce file before any signature, including dry-run; include withdrawal details in the existing hash-chained audit log.
- Keep all other Hyperliquid actions denied and preserve CCTP, Polymarket, caps, allowlist rules, and Solana behavior.

## Install

```sh
npm install evalanche@1.18.0
```

## Compatibility changes

None unless Ops separately approves enabling `hyperliquid-withdraw3`. Generic `typedDataAllow` entries cannot enable Hyperliquid actions. Existing configs keep denying every Hyperliquid payload.

## Withdraw3 rules

The only accepted primary type is `HyperliquidTransaction:Withdraw`, with fields in SDK order: `hyperliquidChain string`, `destination string`, `amount string`, `time uint64`. No extra struct is accepted. Optional `EIP712Domain` must contain exactly the four standard fields in order; an optional `primaryType` must match Withdraw exactly. Domain keys are exactly `name`, `version`, `chainId`, `verifyingContract` with values `HyperliquidSignTransaction`, `1`, numeric 421614, and the zero address.

The Python SDK pins signatureChainId `0x66eee` (421614), including on mainnet. This is neither Arbitrum 42161 nor HyperEVM 999. `hyperliquidChain` must be `Mainnet`. The destination is fixed at `0x0fe61780bd5508b3C99e420662050e5560608cA4` and is validated with ethers `getAddress`; it cannot be changed by config. Amount is a positive decimal string with at most twelve integer digits and six decimal places. Time is a safe non-negative integer number, within T-5min..T+60s. Hyperliquid itself accepts T-2d..T+1d; the signer deliberately uses a tighter window.

The verifier-approved structured intent must use venue `hyperliquid`, action `hyperliquid-withdraw`, and chainId 421614. Both request and intent use that signing chain. Existing intent hash, route hash, approval expiry, and approval nonce checks still apply. Only this exact flagged typed-data shape bypasses chain enablement for 421614; other requests still require an allowed chain.

At sign time, the signer POSTs `{"type":"clearinghouseState","user":"<lowercase signer address>"}` to the fixed `https://api.hyperliquid.xyz/info` URL with a five-second timeout. It fails closed on HTTP/JSON/read errors, invalid withdrawable balances, missing or stale/future state time beyond 30 seconds, and missing or nonempty `assetPositions`. Withdrawable may have up to eight decimals and is compared using integer arithmetic. The reader is injectable only from code, never JSON config. The signer never calls `/exchange` and only returns the signature.

## Upgrade notes for Ops

After separate approval, append this value to the existing config list (preserving its current entries):

```js
explicitAllows: [...existingExplicitAllows, "hyperliquid-withdraw3"]
```

No `typedDataAllow` entry or general chain enablement for 421614 is required. Enabling this flag is a separate approval from installing the release; this release does not authorize it.

The new state file is `<nonceStorePath>.hyperliquid.json`, mode 0600, version 1. It records each wallet's decimal `lastTime` and last 100 used timestamps. Missing history starts empty; corrupt history refuses startup. Timestamps must strictly increase across restarts and are persisted before signatures, including dry-run. Preserve this file with signer state backups; do not reset its high-water mark. The existing approval nonce is still consumed, independently of Hyperliquid timestamps and EVM transaction nonces.

Allow, dry-run, and deny audit entries include a `hyperliquid` object with action `withdraw3`, destination, amount, time, and withdrawable where known, preserving the audit hash chain.

Provision `evalanche-1.18.0.tgz` as a new pin and pass its recorded sha256. Leave older pins in place. See `docs/deploy/grok-bot-box.md`.

## Validation and limitations

The npm tarball cap moved from 1,000,000 to 1,050,000 bytes because the withdraw3 module pushed the pack to about 1,000,700 bytes.

The offline tests inject the info reader, use throwaway keys, and cover the independent SDK vector cross-checked with eth-account 0.13.7 and ethers v6, schema/domain denials, balance failure handling, replay persistence, and audit chaining. Run typecheck, build, release-doc tests, and the full Vitest suite for release validation. One pre-existing local failure, `test/signer/remote-signer.test.ts` > "rejects a decoded transaction that does not match the request" (Ed25519 JWK signing error on local Node 24 and Node 26), also fails on v1.17.0 and is outside this change.

Orders, cancels, leverage changes, spot sends, USD sends, class transfers, agent/builder approvals, vault/sub-account actions, token delegation, cDeposit, sendAsset, and unknown Hyperliquid typed data remain denied, including with the flag enabled. Solana signing remains unavailable.
