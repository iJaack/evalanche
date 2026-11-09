# Evalanche v1.18.0 — CCTP V2 Base and withdraw3-only Hyperliquid signer support

This minor release builds on npm 1.17.0 and includes the CCTP V2 Avalanche <-> Base work already live in 1.17.0-rc.8 (#36), together with withdraw3-only Hyperliquid support. Both signer features are off by default until separately enabled.

## Highlights

- Include the rc.8 CCTP V2 Avalanche <-> Base treasury bridge, with native-USDC burns on Avalanche/Base and receives on Avalanche/Base/Polygon.
- Add opt-in Hyperliquid withdraw3 with an exact lowercase treasury destination, JS-number domain chainId 421614, and verifier-bound request/intent chainId 421614.
- Limit each withdrawal to 35 USDC or a lower `hyperliquidWithdrawMaxUsdc`, and to fresh withdrawable balance with no open positions and a timestamp within T-5min..T+60s.
- Persist Hyperliquid timestamps before signatures, including dry-run, audit withdrawal details, and escrow/restore the optional HL nonce file with shape validation and raise-only wallet timestamps.

## Install

```sh
npm install evalanche@1.18.0
```

## Compatibility changes

Generic `typedDataAllow` entries cannot enable Hyperliquid actions. Existing configs keep denying every Hyperliquid payload unless Ops separately approves enabling `hyperliquid-withdraw3`.

The included rc.8 CCTP changes require `buildCctpBurn` callers to supply `destinationDomain`; the previous Polygon default is removed. Configured burn destinations and receive sources must be enabled entries in `CCTP_CHAINS`. Polygon remains receive-only and cannot set `destinationDomains` or be a receive source. Arbitrum is listed but disabled. Existing CCTP configs using those formerly accepted values must be corrected before startup.

## Included CCTP V2 Base support

Base 8453 (Circle domain 6) joins Avalanche for native-USDC burns with exact TokenMessengerV2 approvals; Avalanche, Base and Polygon may receive. Base native USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Transfers remain treasury to treasury, with treasury mint recipient and burn caller, zero destination caller unless pinned, finality 2000, `maxFee` defaulting to zero, and no hooks. Base burns only to Avalanche (domain 1); Avalanche allows Base 6 and Polygon 7. Receive sources must be enabled burning chains. Standard Iris vectors cover both Avalanche/Base directions with expirationBlock 0; expiry checks are unchanged. CCTP stays off until configured; enabling Avalanche <-> Base requires a separate config change and verifier update.

## Withdraw3 rules

The only accepted primary type is `HyperliquidTransaction:Withdraw`, with fields in SDK order: `hyperliquidChain string`, `destination string`, `amount string`, `time uint64`. No extra struct is accepted. Optional `EIP712Domain` must contain exactly the four standard fields in order; an optional `primaryType` must match Withdraw exactly. Domain keys are exactly `name`, `version`, `chainId`, `verifyingContract` with values `HyperliquidSignTransaction`, `1`, numeric 421614, and the zero address.

The Python SDK pins signatureChainId `0x66eee` (421614), including on mainnet. The signer domain accepts only the JS number 421614; strings, bigint, null, missing values and every other chainId are denied. `hyperliquidChain` must be `Mainnet`. The exported `HYPERLIQUID_WITHDRAW_DESTINATION` is `0x0fe61780bd5508b3c99e420662050e5560608ca4`; destination must match this lowercase string exactly (`===`). Checksummed, uppercase, mixed case, whitespace and missing-prefix forms are denied; config cannot change it. Amount is a positive decimal string with at most twelve integer digits and six decimal places. Time is a safe non-negative integer number, within T-5min..T+60s. Hyperliquid itself accepts T-2d..T+1d; the signer deliberately uses a tighter window.

The per-withdrawal hard cap is `HL_WITHDRAW_MAX_USDC = "35"`. Optional signer config `hyperliquidWithdrawMaxUsdc` accepts a positive number or a decimal string with at most six decimals and can only lower this cap. Missing, invalid, non-finite, non-positive or above-35 values fall back to 35 without failing startup. Exponent strings are invalid. Finite positive numbers are truncated down to six decimals, never rounded up (a positive sub-micro number therefore permits no positive withdrawal). Amount must be at most both this cap and fresh withdrawable balance, using integer arithmetic.

The verifier-approved structured intent must use venue `hyperliquid`, action `hyperliquid-withdraw`, and chainId 421614. Both request and intent use that signing chain. Existing intent hash, route hash, approval expiry, and approval nonce checks still apply. Only this exact flagged typed-data shape bypasses chain enablement for 421614; other requests still require an allowed chain.

At sign time, the signer POSTs `{"type":"clearinghouseState","user":"<lowercase signer address>"}` to the fixed `https://api.hyperliquid.xyz/info` URL with a five-second timeout. It fails closed on HTTP/JSON/read errors, invalid withdrawable balances, missing or stale/future state time beyond 30 seconds, and missing or nonempty `assetPositions`. Withdrawable may have up to eight decimals and is compared using integer arithmetic. The reader is injectable only from code, never JSON config. The signer never calls `/exchange` and only returns the signature.

## Upgrade notes for Ops

After separate approval, append this value to the existing config list (preserving its current entries):

```js
explicitAllows: [...existingExplicitAllows, "hyperliquid-withdraw3"]
```

No `typedDataAllow` entry or general chain enablement for 421614 is required. Enabling this flag is a separate approval from installing the release; this release does not authorize it.

The new state file is `<nonceStorePath>.hyperliquid.json`, mode 0600, version 1. It records each wallet's decimal `lastTime` and last 100 used timestamps. Missing history starts empty; corrupt history refuses startup. Timestamps must strictly increase across restarts and are persisted before signatures, including dry-run. Box escrow/restore includes optional `nonces.json.hyperliquid.json` in the hash manifest and restores it as evalanche-signer mode 0600. Restore validates the exact nonce shape before writes and refuses lower timestamps or wallets missing from escrow that exist in current HL state. An escrow without HL state leaves the current HL file in place. Preserve this file with signer state backups; do not reset its high-water mark. The existing approval nonce is still consumed, independently of Hyperliquid timestamps and EVM transaction nonces.

Allow, dry-run, and deny audit entries include a `hyperliquid` object with action `withdraw3`, destination, amount, time, and withdrawable where known, preserving the audit hash chain.

Provision `evalanche-1.18.0.tgz` as a new pin and pass its recorded sha256. Leave older pins in place. See `docs/deploy/grok-bot-box.md`.

## Validation and limitations

The npm tarball cap moved from 1,000,000 to 1,050,000 bytes because the withdraw3 module pushed the pack to about 1,000,700 bytes.

The offline tests inject the info reader, use throwaway keys, and cover the independent SDK vector cross-checked with eth-account 0.13.7 and ethers v6, schema/domain denials, balance failure handling, replay persistence, and audit chaining. Run typecheck, build, release-doc tests, and the full Vitest suite for release validation. One pre-existing local failure, `test/signer/remote-signer.test.ts` > "rejects a decoded transaction that does not match the request" (Ed25519 JWK signing error on local Node 24 and Node 26), also fails on v1.17.0 and is outside this change.

Orders, cancels, leverage changes, spot sends, USD sends, class transfers, agent/builder approvals, vault/sub-account actions, token delegation, cDeposit, sendAsset, and unknown Hyperliquid typed data remain denied, including with the flag enabled. Solana signing remains unavailable.
