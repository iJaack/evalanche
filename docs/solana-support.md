# Solana signer support

## Summary and status

This is phase 0. Nothing described here is implemented. The baseline is `cursor/provision-escrow-684c` at `3c1220b`, release `1.17.0-rc.7`. Implementation PRs stack on `feat/solana-support`.

The goal is Jupiter v6 treasury swaps in phase 1. pump.fun and PumpSwap are phase 2. Every new path is off by default. No mainnet transaction is authorized by this document. Giacomo must approve mainnet enablement. No merge, tag, or release proceeds without his approval. PR #22 stays untouched.

The intent envelope, install-time treasury key, phase-1 assets and programs, 100 bps slippage, 1,000,000 lamport priority-fee cap, 30 second quote age, 120 second intent lifetime, and $2 fee cap are inputs from Mony, 26 Oct 2026. These are config values, not hardcoded economic defaults. The per-transaction value cap has no decided default.

The recommendations below are a design for later TDD-first PRs. They do not authorize a live config edit, a key generation, a dependency install, or a transaction. Unverified protocol details are assigned to an implementation PR.

## Current EVM architecture

```text
proposer -> canonical request -> verifier approval -> remote signer
                                                   |
                       strict intent + approval + transaction match
                                                   |
                       decode -> economics -> simulation
                                                   |
                       persist replay state -> sign -> append audit
```

| Path | Current behavior |
| --- | --- |
| `src/signer/intent.ts` | `assertIntentShape` validates exact allowed keys and required fields. `computeIntentHash` is keccak256 of UTF-8 JCS. Transaction `routeHash` is keccak256 of the canonical full `ApprovedTransaction`, not just calldata. Message and typed-data routes have separate material. |
| `src/signer/jcs.ts` | Sorted object keys, NFC strings, safe integers, and no prototype keys. Money and nonces use decimal strings. Floats are rejected. |
| `src/signer/intent.ts`, `src/signer/ed25519.ts` | `approvalSigningBytes` uses `evalanche-verifier/v1\0`, decision, mode, signer address, chain id, and raw intent hash. Ed25519 approvals pin a canonical prime-order verifier key and reject malformed signatures. `dry-run` and `live` are bound. |
| `src/signer/server.ts` | `handleLocked` serializes requests. `evaluate`, `assertApproval`, `assertNonce`, and `assertTransaction` bind wallet, chain, expiry, nonce, hash, and every approved transaction field. Economics and simulation precede replay persistence and signing. Dry-run performs checks and consumes the nonce without signing. |
| `src/signer/nonce-store.ts`, `src/signer/flock.ts` | Version 1 state has per-wallet `lastNonce` high-water and `used`, plus per-wallet/per-chain `txNonces`. Writes use fsync, rename, and directory fsync. Darwin uses `O_EXLOCK`. Linux uses a SHA-256-pinned flock helper. Lock loss halts the signer. `startedAt` rejects older approvals. |
| `src/signer/server.ts` | `audit` appends and fsyncs JSONL. `loadAudit` verifies SHA-256 links from `AUDIT_ROOT = sha256(UTF-8("evalanche-audit-root/v1"))`. Each `prevHash` hashes the previous line without its newline. |
| `src/signer/decode.ts` | The allow map grants selectors and roles. Known calldata is decoded. Unknown calls fail closed. Generic Polymarket calls and typed data are denied. This stack has explicit gated Polygon Polymarket exceptions; those do not authorize Solana prediction markets. Benqi instant unstake and Hyperliquid typed-data denials remain. |
| `src/signer/server.ts`, `src/signer/price-feed.ts` | Decoded amounts must match intents. SpendingPolicy, token caps, USD caps, trusted decimals, and address-bound prices constrain spend. Gas has native and USD caps. Simulation runs from the signer address. Unavailable prices or failed simulation deny. |
| `src/signer/chain-policy.ts` | `chains` has per-chain caps, prices, RPCs, `enabled`, and `killSwitch`. Avalanche has legacy enablement behavior. Other registered chains require opt-in. A kill switch wins. Solana must not inherit Avalanche enablement. |
| `src/signer/server.ts`, `docs/deploy/grok-bot-box.md` | `SignerServerOptions` and `assertStartup` reject unknown config and incomplete enabled-chain policy. The box loads the EVM key from `EVALANCHE_SIGNER_PRIVATE_KEY`. The dedicated user and protected paths enforce local policy; TM-008 states they do not resist root-capable agents. |
| `src/signer/remote-client.ts` | Bearer-authenticated HTTP or Unix socket. Returned EVM transactions are decoded and matched before broadcast. The client rejects dry-run results as unsigned. |
| `.github/workflows/ci.yml` | `check` runs Node 20.19.2 and 22 tests, typecheck, build, docs/package/consumer/smoke checks, and the audit gate. `signer-linux-clean`, `signer-macos`, `flock-reproducible`, `signer-root-layout`, `signer-root-restore`, and `reproducible-pack` cover signer packaging and state. |

EVM approval TTL is currently at most `MAX_APPROVAL_TTL_MS = 600000`. Its future creation skew is 30 seconds. Solana gets its own tighter lifetime checks. Existing EVM bytes, behavior, and version 1 state remain compatible.

## Solana intent schema

Keep `kind: "transaction"`, as requested by Mony, 26 Oct 2026. Dispatch on the type and exact value of `chainId`. EVM uses an integer. Solana uses only `"solana:mainnet"` or `"solana:devnet"`. A new kind would duplicate transport and approval plumbing without separating chains more safely. Use a discriminated union internally. Never call `Number(chainId)` or EVM address normalization before dispatch. Numeric strings and unknown cluster strings are denied.

Retain the request envelope and structured intent version `"1"`. Solana has an exact chain-specific schema. Do not broaden the EVM key set. `action` is exactly `swap`, `approve`, `revoke`, or `transfer`. Solana message signing, typed data, bridges, and arbitrary calls are out of scope.

### Field types and outer mapping

| Field | Solana type and rule |
| --- | --- |
| `requestId`, `intent` | Non-empty NFC strings. `intent` is descriptive and grants no authority. |
| `kind`, `chainId`, `from` | Literal `"transaction"`; cluster string above; canonical base58 treasury public key. |
| `structuredIntent`, `approval` | Required intent object; `null` in a proposal, exact approval object at the signer. `null` never signs. |
| Outer `to`, `data`, `value`, `gasLimit`, `nonce` | Absent and rejected if supplied. `structuredIntent.tx` is the sole transaction payload. There is no EVM recipient, value, gas, or account nonce alias. |
| Outer `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `type`, `message`, `typedData` | Absent and rejected on Solana. EVM keeps its present fields and types. |
| `version`, `intentId`, `nonce` | Literal `"1"`, non-empty string, canonical unsigned decimal string. `nonce` is the verifier approval sequence, not a blockhash or durable nonce. |
| `createdAt`, `expiresAt`, `quotedAt` | Non-negative safe integer Unix milliseconds. `quotedAt` is required only for swaps. |
| `wallet`, `chainId`, `venue`, `action` | Treasury base58 pubkey, exact request cluster, venue enum `jupiter-v6`, `spl-token`, or `system`, action enum. All are hash-bound. |
| `routeHash` | Lowercase `0x` plus 64 hex digits: SHA-256 of decoded `tx.serializedMessage` bytes. Not a hash of the base64 text or a signed transaction. |
| `tx.serializedMessage` | Canonical padded base64 of the complete unsigned v0 message. Strictly decode, parse, re-encode, and require identical bytes. No signatures are embedded. |
| `tx.recentBlockhash`, `tx.lastValidBlockHeight` | Recent-blockhash variant only: canonical base58 32-byte blockhash and non-negative safe integer block height. Both required. Height is metadata checked against RPC, not part of the Solana wire message. |
| `tx.durableNonce` | Durable variant only: exact object `{nonceAccount, nonceAuthority, nonceValue}`, all canonical base58 32-byte values. Authority must be treasury. Omit `recentBlockhash` and `lastValidBlockHeight`; a durable nonce has no recent-blockhash height expiry. |
| `tx.computeUnitLimit`, `tx.computeUnitPriceMicroLamports` | Positive safe integer count; unsigned decimal string micro-lamports per CU. Both must equal the decoded ComputeBudget instructions. |
| `tokenIn`, `tokenOut` | Exact objects `{mint: string, symbol: string, decimals: number}`. Mint is canonical base58, symbol is NFC, decimals is a safe integer from 0 to 255. Chain account data and config determine decimals, not the symbol. `tokenOut` is swap-only. |
| `amountIn`, `minAmountOut`, `quotedAmountOut` | Unsigned decimal strings in raw token units, bounded to u64 where the instruction uses u64. Input is required for every action. Output fields are required only for swaps. Revoke has `amountIn: "0"`. |
| `slippageBps`, `maxSlippageBps` | Swap-only safe integers from 0 to 10000. Require both and equality in phase 1. `maxSlippageBps` preserves the current verifier field; `slippageBps` is Mony's Solana quote field. Neither may exceed config. |
| `quoteId`, `programIds` | Swap-only non-empty quote reference string; required sorted, duplicate-free base58 program list for every action. `quoteId` is a correlation id, not proof of a quote. `programIds` commits to all invoked programs, including CPI; re-derive it before signing. |

Every money amount, token amount, lamport amount, price, and approval nonce uses a string. No floats enter JCS. Parse integer quantities with bigint for arithmetic and enforce wire-width bounds. Reject signs, exponents, leading zeros except `"0"`, unsafe numbers, malformed base64, non-canonical base58, unknown fields, prototype keys, and missing required fields. Apply `assertExactKeys` semantics recursively, with separate required-key checks and action-specific field sets. `tx` must contain exactly one lifetime variant.

`intentHash` stays `keccak256(UTF-8(JCS(normalized structuredIntent)))`, with a `0x` hex result. This preserves the verifier's canonical hash contract. Solana uses Ed25519 to sign message bytes, which does not require changing the intent hash algorithm. Domain separation below prevents cross-chain approval reuse. `routeHash` separately uses Solana's message bytes and SHA-256.

### Jupiter swap proposal

This is a complete JSON template, not a signable fixture. Angle-bracket values are typed string substitutions. No treasury address exists yet. The message, blockhash, route hash, CPI set, and amounts must come from one verified route. PR5 supplies recorded valid bytes; this document does not invent a Jupiter encoding or AMM id.

```json
{
  "requestId": "solana-jupiter-1",
  "kind": "transaction",
  "chainId": "solana:mainnet",
  "from": "<treasury base58 public key>",
  "intent": "Swap 100 USDC for wSOL through Jupiter v6",
  "structuredIntent": {
    "version": "1",
    "intentId": "jupiter-1",
    "nonce": "1",
    "createdAt": 1793012400000,
    "expiresAt": 1793012490000,
    "wallet": "<treasury base58 public key>",
    "chainId": "solana:mainnet",
    "venue": "jupiter-v6",
    "action": "swap",
    "routeHash": "<0x plus lowercase SHA-256 of message bytes>",
    "tx": {
      "serializedMessage": "<canonical base64 v0 message>",
      "recentBlockhash": "<base58 recent blockhash from the same message>",
      "lastValidBlockHeight": 300000100,
      "computeUnitLimit": 300000,
      "computeUnitPriceMicroLamports": "1000000"
    },
    "tokenIn": {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "decimals": 6
    },
    "amountIn": "100000000",
    "tokenOut": {
      "mint": "So11111111111111111111111111111111111111112",
      "symbol": "wSOL",
      "decimals": 9
    },
    "minAmountOut": "495000000",
    "quotedAmountOut": "500000000",
    "maxSlippageBps": 100,
    "slippageBps": 100,
    "quoteId": "recorded-jupiter-quote-1",
    "quotedAt": 1793012395000,
    "programIds": [
      "<sorted complete top-level and CPI program ids>"
    ]
  },
  "approval": null
}
```

### Exact SPL approve proposal

This authorizes one `approveChecked` of 100 USDC units, not an unlimited allowance. The delegate and source ATA are encoded in the message and therefore bound by both hashes. The verifier displays and validates them. No additional delegate field is accepted in version 1 of this proposal.

```json
{
  "requestId": "solana-approve-1",
  "kind": "transaction",
  "chainId": "solana:mainnet",
  "from": "<treasury base58 public key>",
  "intent": "Approve an allowlisted delegate for exactly 100 USDC",
  "structuredIntent": {
    "version": "1",
    "intentId": "approve-1",
    "nonce": "2",
    "createdAt": 1793012400000,
    "expiresAt": 1793012490000,
    "wallet": "<treasury base58 public key>",
    "chainId": "solana:mainnet",
    "venue": "spl-token",
    "action": "approve",
    "routeHash": "<0x plus lowercase SHA-256 of message bytes>",
    "tx": {
      "serializedMessage": "<canonical base64 v0 message with exact approveChecked>",
      "recentBlockhash": "<base58 recent blockhash from the same message>",
      "lastValidBlockHeight": 300000100,
      "computeUnitLimit": 50000,
      "computeUnitPriceMicroLamports": "1000000"
    },
    "tokenIn": {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "decimals": 6
    },
    "amountIn": "100000000",
    "programIds": [
      "ComputeBudget111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    ]
  },
  "approval": null
}
```

The approval object keeps exact fields `intentHash: string`, `nonce: string`, `expiresAt: number`, `verifier: string`, `signature: string`, `decision: "approve" | "deny"`, `mode: "dry-run" | "live"`, and `signerAddress: string`. `verifier` remains hex-encoded 32-byte Ed25519; `signature` remains hex-encoded 64-byte approval signature. `signerAddress` is treasury base58 on Solana. Nonce and expiry must equal the intent. Only `approve` signs.

## Approval binding

Define Solana approval bytes as:

```text
UTF-8("evalanche-verifier/solana/v1\0")
|| UTF-8(decision) || 0x00
|| UTF-8(mode) || 0x00
|| UTF-8(signerPubkey) || 0x00
|| UTF-8(cluster) || 0x00
|| raw32(intentHash)
```

`signerPubkey` is the canonical base58 `approval.signerAddress`, equal to `from` and `wallet`. `cluster` is the exact `chainId`, including `solana:`. Reject embedded NUL, invalid enum values, non-canonical keys, wrong hash width, mismatched mode, wallet, cluster, expiry, or nonce. Pin the same verifier public-key mechanism and strict Ed25519 validation.

EVM `approvalSigningBytes` and `evalanche-verifier/v1\0` are unchanged. PR1 tests both directions of EVM/Solana substitution, mainnet/devnet substitution, another treasury, mutated message, deny/approve substitution, and dry-run/live substitution. Identical intent hashes do not bridge the domains.

## Key type and custody

Use a separate Ed25519 treasury keypair for Solana. `from` is its base58 public key. It is not derived from the EVM key, and it is not the verifier approval key. Ops generates it inside the signer at install time (Mony, 26 Oct 2026). Proposer, SDK, MCP, and verifier receive only the public key.

Node's `node:crypto` generates and signs Ed25519 natively. Sign the original message bytes with `sign(null, message, keyObject)`. Solana codecs handle public bytes only. No third-party signing adapter receives a seed, secret buffer, or `KeyObject`.

| Option | Design and cost |
| --- | --- |
| Signer init command; recommended | A future explicit init command creates the key once. It atomically writes a 64-byte seed-plus-public-key secret to the signer state directory, mode `0600`, owner `evalanche-signer`, beneath mode `0700`. Use exclusive creation, no symlinks, checked descriptors, fsync, and directory fsync. Refuse an existing path; never regenerate on normal startup. Print only base58 pubkey. Validate the public half against the seed when loading into Node crypto. |
| `EVALANCHE_SIGNER_SOLANA_SECRET_KEY` | A future alternative accepts a canonical base64 64-byte secret at launch, then removes the variable before helper startup. Mutually exclusive with a file. This matches EVM launch handling but leaves initial environment exposure and requires an external secret custodian. It weakens the install-time non-export custody goal and needs an explicit Ops choice. |

Recommend the init command. The key is never returned, logged, committed, or exported from the signer. Only the signer process holds it at runtime; the recommended option also has a protected at-rest file. Ops must decide backup and recovery before funding it. The existing box escrow copies replay/audit/token files, not this new key. Do not silently include a treasury secret in box-readable escrow or rotate it after a reset. PR2 must design key recovery and PR4 must extend replay-state restore together.

The shared box still has root-capable agents. File permissions and a native signing library do not change TM-008. Enabling Solana requires a fresh owner review of that exposure.

## Transaction building and simulation

Use unsigned v0 messages. Require the treasury as fee payer and the only required signer in phase 1. Reject extra signer slots, invalid account indices, duplicate or ambiguous keys, malformed lengths, legacy messages, and trailing bytes. The signer returns `signedTransaction` as canonical base64 of the signed wire transaction and `signature` as the base58 transaction signature. PR6 makes the remote client decode it, compare the entire message byte-for-byte, verify the Ed25519 signature and signer slots, and reject a mismatched `requestId` before broadcast. EVM result encoding stays hex.

Prefer Jupiter `/swap-instructions` to `/swap`. It exposes setup, compute budget, swap, cleanup, and ALT references for review before compilation. `/swap` returns a serialized transaction; it may be accepted only after stripping no bytes and re-deriving the same checks from its unsigned message. Never trust API-supplied fees, recipients, or simulation claims. Builders must not modify a message after approval. A changed blockhash, CU budget, or route requires a fresh intent and approval.

Recommend static-key-only v0 messages for initial phase 1. An empty address-table lookup list avoids an extra mutable input. Mony must confirm the route-size restriction is acceptable. Reject messages that cannot fit; do not silently switch to legacy or drop instructions. PR2 still specifies and tests ALT resolution behind `alt.enabled: false`.

With ALTs enabled, resolve every table through signer-controlled RPC, verify its account owner and table layout, lifecycle, indices, writable/readonly order, and address contents. Record table address, account-data hash, and RPC context slot. Require the verifier to derive the same expansion. Proposer-supplied tables are hints only: re-fetch and compare. Pin a common bank snapshot where supported. `minContextSlot` is a lower bound, not a historical-slot pin. If RPC cannot provide matching snapshots, reject inconsistent reads; do not claim it pinned a slot. Exact ALT activation/deactivation and extension semantics are to verify in PR2. Re-fetch before signing and deny changed used entries or unresolved tables.

Fetch pre-state for every treasury token account and every writable account that may receive treasury funds. Run `simulateTransaction` on the exact message in a transaction with zero signature bytes, with `sigVerify: false`, `replaceRecentBlockhash: false`, `innerInstructions: true`, and `accounts` requesting base64 post-state. Require complete accounts and inner instructions, successful execution, an acceptable context slot, and fresh lifetime checks. Treat missing, truncated, unsupported, or inconsistent RPC results as denial. Use matching pre/post snapshots; otherwise fail closed. A closed account has a null post-state and must match a decoded permitted close.

Decode pre/post mint, owner, amount, delegate, account flags, and lamports. Verify treasury input debit equals the exact input for an exact-in swap, output credit is at least `minAmountOut`, and no unrelated treasury asset loses value. Account separately for fees, ATA rent, and native/wSOL movement. Derive rent from the validated account size and RPC rent-exemption minimum; cap cumulative new rent with `maxRentLamports`. Do not infer safety from net deltas alone: decode every transfer and inner instruction so a transfer out and back cannot hide a recipient.

Mony's rule is that every outgoing recipient and every ATA owner is the treasury (Mony, 26 Oct 2026). Read literally, the signer denies if any non-treasury-owned account receives tokens from the treasury. Enforce it literally until clarified. It also denies ordinary Jupiter swaps, which pay input into AMM pool vaults. An inner-program allowlist alone does not fix this conflict.

Recommended clarification for PR5: final recipients and user ATAs must be treasury-owned; only consideration paid into independently decoded and validated route pool vaults may be exempt. That exemption requires Mony's confirmation, verified AMM adapters, and explicit `jupiter.allowPoolTransfers: true`. Until then it stays false and swaps that pay external pools are denied. No broad Jupiter recipient exemption is proposed. The fixture route must demonstrate the exact exception before mainnet review.

## Policy mapping

All rules below run in the verifier and again in the signer. Denial precedes any signature. Config keys below are relative to `solana.clusters[chainId]` unless stated otherwise.

### Program allowlist

Decode every top-level program id after ALT expansion. Derive all CPI programs from simulation `innerInstructions`, including nested invocations. Require their sorted union to equal `intent.programIds`. Logs alone are not a program trace. Deny unknown, omitted, non-executable, or hard-denied programs, missing CPI traces, and routes whose invocation structure cannot be accounted for.

Recommend an explicit `innerPrograms` allowlist plus independently decoded route/pool constraints. Allowing every CPI because the parent is Jupiter trusts an aggregator with arbitrary treasury effects. Membership in `programs` grants top-level access only; it never authorizes an instruction without a decoder. CPI membership also requires that program's permitted semantics. No AMM program id is invented here. The six Mony programs alone do not enable an AMM route. Ops must add reviewed inner programs for PR5.

Config: `programs`, `innerPrograms`, `jupiter.enabled`, `jupiter.pools`. Tests: one unknown top-level program, hidden CPI, missing inner trace, undeclared CPI in `programIds`, allowed program with unknown instruction, and modified pool vault each deny. Cover a complete reviewed route in PR5.

### Instruction decoders

Decode discriminator, exact data length, account order, signer/writable flags, and authority for every instruction. Re-encode and compare bytes. Program membership never permits all its instructions. Exact layouts and SPL/ATA/System/ComputeBudget opcode values are to verify against pinned official interfaces in PR3; Jupiter layouts are to verify in PR5.

| Program | Allowed semantics | Denials and limits |
| --- | --- | --- |
| System | `transfer` only treasury-to-treasury or bounded funding of its validated wSOL ATA. `advanceNonceAccount` only under the durable-nonce rule. | Deny top-level `assign`, `allocate`, `createAccount`, seeded variants, nonce initialization/withdrawal/authority change, and unknown instructions. ATA creation may perform System `createAccount` or `allocate`/`assign` through CPI only within a decoded ATA flow, for its exact derived treasury ATA, correct token program, space, and rent. These are narrow PR3 exceptions, not generic System permissions. |
| SPL Token and Token-2022 | `transferChecked`, `approveChecked`, `revoke`, `closeAccount`, `syncNative`, `initializeAccount3`. | Deny unchecked `transfer` and unchecked `approve`, including CPI, in phase 1. Deny `setAuthority`, `burn`, `mintTo`, freeze/thaw, mint initialization, multisig authorities, and unknown operations. Routes using unchecked transfers remain unsupported. Fixtures must establish whether the proposed Jupiter route survives this rule. |
| ATA | `create`, `createIdempotent`. | Payer and token owner must be treasury; token program and derived ATA must match mint. Existing account must have the same mint and treasury authority. Deny recoverNested and unknown forms. |
| ComputeBudget | Exactly one `setComputeUnitLimit` and one `setComputeUnitPrice`. | Deny duplicates, omitted values, out-of-range values, and mismatch with `tx`. Deny `requestHeapFrame` and loaded-account data-size changes unless explicitly configured and bounded. Their exact instruction names/layouts are to verify in PR3. |

`initializeAccount3` is limited to the ATA creation CPI for the derived treasury account. No arbitrary temporary keypair accounts in phase 1. `syncNative` only touches its validated wSOL ATA. `closeAccount` only closes a treasury-owned wSOL ATA in a decoded unwrap flow, with treasury as authority and rent destination. Other token accounts cannot be closed in phase 1. Approve and revoke are separate actions; setup/cleanup cannot hide either inside a swap. Deny state mutations inconsistent with the declared action.

Config: `programs`, `innerPrograms`, `allowWsol`, `maxRentLamports`, `fees.maxHeapFrameBytes`, `fees.maxLoadedAccountsDataSizeBytes`. The last two keys are optional; absence denies the extra instruction. If configured, permit at most one each and enforce a positive safe integer bound. Tests: forbidden opcode, trailing bytes, wrong flags, duplicate CU instruction, rogue System account, extra signer, unexpected CPI initialization, rent theft, and unchecked transfer each deny. Test valid ATA creation and wSOL wrap/unwrap separately in PR3.

### Mint allowlist and treasury ownership

Phase-1 mainnet mint candidates are the exact inputs from Mony, 26 Oct 2026:

| Mint | Address |
| --- | --- |
| wSOL | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

The token program that owns account data is distinct from the token account's owner authority. Verify both. Re-derive the ATA from treasury, mint, token program, and ATA program. Source and user destination authority must be treasury; being a valid address or a writable account is insufficient. Fetch mint decimals and compare config and intent. All path assets, including intermediates, must be allowed. No symbol-based admission.

Deny Token-2022 mints/accounts with transfer hooks, permanent delegates, transfer fees, confidential transfers, or other unreviewed extensions in phase 1. Extension-free support must be established in PR3. The mere presence of Token-2022 in the program list does not permit its extensions. Deny unknown TLV data and unsupported account flags. Validate the native mint, token program, rent reserve, and lamport accounting for wSOL. Funding and closing must return all proceeds and rent to treasury. Never count wrapped SOL twice as native spend.

Config: `mints` maps mint to `{symbol, decimals, tokenProgram}`, `allowWsol`, `jupiter.pools`, and `jupiter.allowPoolTransfers`. Tests: wrong authority, wrong mint, valid ATA for another owner, forged decimals, substituted token program, extension-bearing mint, extra intermediate mint, and redirected close destination deny. Pool exceptions remain subject to the unresolved recipient rule above.

### Transfer action

Decode `transferChecked` and any supported System transfer. Destination authority must be treasury and token destination must be the derived treasury ATA. Source must also be treasury-owned. Amount and mint must match `amountIn` and `tokenIn`. SPL transfers use `venue: "spl-token"`; native self-transfers use `venue: "system"`, `tokenIn.mint` equal to the native wSOL mint, and decimals 9. The decoded System instruction distinguishes native lamports from SPL balances; the symbol is display-only. Price and cap native principal under `native`. No external payment is allowed. A self-transfer between identical accounts must not be miscounted as an input debit.

This means same-wallet token-account/ATA moves and native self-transfers, not treasury withdrawals. Phase 1's ATA-only policy may leave no useful distinct source/destination for one mint. Ask Mony what `transfer` is for before adding non-ATA source support.

Config: `mints`, `tokenCaps`, `maxPerTxUsd`, `maxRentLamports`. Tests: treasury destination succeeds in the fixture; external owner, non-ATA destination, delegated source, and amount mismatch deny. No config recipient list can enable external transfers.

### Exact SPL approve and revoke

Decode `approveChecked` source, mint, delegate, authority, amount, and decimals. Require `venue: "spl-token"`, treasury source ATA and authority, allowlisted mint, delegate in `delegates`, and positive amount exactly equal to `intent.amountIn`. Deny `u64::MAX`, extra approvals, unchecked approve, and hidden spend in an approve request. Decode existing delegated state; replacement must still pass the exact-amount check.

`revoke` needs `venue: "spl-token"`, action `revoke`, and `amountIn: "0"`. It is always allowed for an allowlisted mint under the common approval, fee, lifetime, and treasury checks, even if the old delegate is no longer allowlisted. Revocation does not waive signature or replay checks. No delegate is configured by default. Approval does not expire on-chain when its signing intent expires. Proposer pairs it with a swap and revokes leftovers after failure; an exact allowance is still spend authority until consumed or revoked.

Config: `delegates`, `mints`, `tokenCaps`. Tests: exact approve and revoke pass; excess, zero approve, max-u64, wrong delegate, wrong decimals, wrong authority, and a second approval deny. Revoking a removed delegate passes in PR3.

### Jupiter v6

Decode `route`, `sharedAccountsRoute`, and `exactOutRoute`. Jupiter added `route_v2`, `exact_out_route_v2`, `shared_accounts_route_v2`, and `shared_accounts_exact_out_route_v2` in October 2025; the v1 forms remain valid ([Jupiter changelog, October 2025](https://developers.jup.ag/changelog/2025-10), checked 26 Oct 2026). The v2 forms carry `positive_slippage_bps` and allow platform fees above 255 bps, so phase 1 requires `platform_fee_bps == 0` and `positive_slippage_bps == 0` on every admitted form. Token-ledger variants stay denied. Names here are requirements to inspect, not asserted discriminator values; take discriminators and layouts from the on-chain Anchor IDL account of JUP6 in PR5. PR5 must verify the deployed JUP6 program and official IDL revision, discriminators, exact account ordering, optional accounts, route-plan encoding, platform fees, shared-account PDAs, token-ledger variants, and exact-in versus exact-out fields. Record source revision and fixture provenance. An absent or unknown variant stays denied. Do not guess layouts from an Anchor name hash.

For exact-in routes, require `in_amount == amountIn`, `quoted_out_amount == quotedAmountOut`, and decoded `slippage_bps <= min(intent.slippageBps, config.maxSlippageBps)`. Require intent bps equality from the schema and reject a looser intent than config. `platform_fee_bps == 0`; deny a fee account or positive integrator/platform transfer. User transfer authority is treasury. Input/output mints, source ATA, and final destination ATA must match the intent and treasury. Verify every route step and pool vault against its AMM decoder. Shared route accounts need their own validated PDA and flow accounting; unsupported forms deny.

Use the EVM integer floor: `floor = quotedAmountOut * (10000 - effectiveBps) / 10000`, with bigint division and `effectiveBps = min(slippageBps, config.maxSlippageBps)`. Require positive quote and positive floor. Require `minAmountOut >= floor`, decoded enforceable output threshold at least `minAmountOut`, and simulation credit at least that threshold. Decode the program's actual rounding and threshold derivation; deny if it cannot enforce the stated bound.

`exactOutRoute` does not necessarily encode `in_amount` or `quoted_out_amount` with exact-in meaning. PR5 must prove a variant-specific mapping of fixed output and maximum input to this intent before admitting it. Recommend exact-in only for initial enablement; exact-out and v2 forms stay denied until equivalent tests pass. Never pretend exact-out has verified exact-in fields.

At signing, require `0 <= now - quotedAt <= quoteMaxAgeMs`, configured as 30000. Future or stale quotes deny. Recheck after simulation. A quote id and proposer timestamp cannot prove API origin; verifier independently fetches/reconciles the quote and enforces freshness. Swaps require `venue: "jupiter-v6"`. A label never bypasses byte decoding.

Config: `jupiter.enabled`, `jupiter.allowPoolTransfers`, `jupiter.pools`, `programs`, `innerPrograms`, `maxSlippageBps`, `quoteMaxAgeMs`. Tests: reference exact-in fixtures, every supported variant, mutated amounts/authority/destination, hidden fee, unknown route step, stale/future quote, zero floor, integer boundary, and simulation output below floor. Unverified variants and literal-recipient conflicts must deny.

### Fee caps

Decode CU limit and micro-lamport price from the message. Bound both against config. Use `priorityFeeLamports = (limit * price + 999999) / 1000000` with bigint arithmetic. Require it at or below `maxPriorityFeeLamports`, configured as `"1000000"` (0.001 SOL). Budget requested units, not only simulated consumed units. Reject overflow and missing CU instructions.

Phase-1 fee model is `totalFeeLamports = 5000 * requiredSignatures + priorityFeeLamports`. Require one treasury signature and no signature-verification precompile. PR3 verifies the fee assumption against cluster `getFeeForMessage`; use the greater of the model and RPC fee, and deny unsupported fee schedules or unavailable fee data. ATA rent and wrapping principal are separate cash outflows, not transaction fees; check them under value/rent accounting. Jito tips and other extra transfers have no phase-1 exemption.

Price SOL with CoinGecko id `solana`. Require `ceil(totalFeeLamports * solPriceUsdMicros / 1000000000)` within the USD cap, configured as `"2"`. Reuse EVM feed freshness, inclusive bounds, static-reference sanity rules, timeout, byte cap, HTTPS endpoint restriction, redirect denial, and fail-closed behavior. Default upstream max age is 600000 ms unless config tightens it. Do not retain a stale last-good price. Solana price keys are case-sensitive mint/base58 keys; do not lowercase them as EVM addresses.

Config: `fees.maxComputeUnitLimit`, `fees.maxComputeUnitPriceMicroLamports`, `fees.maxPriorityFeeLamports`, `fees.maxFeeUsd`, `price`. CU limit and CU-price cap need explicit Ops values before enablement. Tests: exact lamport cap, one micro-lamport rounding above it, one USD micro above $2, excessive CU count/price, duplicate budgets, stale/unbounded price, missing fee response, and fee-schedule mismatch.

### Token caps and per-transaction value cap

Decode the gross authorized debit per mint, including approve authority, plus native principal/rent outflow. Match intent raw units and trusted mint decimals. Require `tokenCaps` for every allowed mint and `native`; enforce quoted-output caps as on EVM. Price sold assets once and account for wSOL/native equivalence. Do not sum every AMM hop as fresh treasury spend or substitute simulated net loss for gross spend. Revoke authorizes no token debit.

`maxPerTxUsd` is configurable as a canonical USD decimal string with up to six fractional digits, converted to integer micros. Its default is undecided. Enabled-cluster startup must require an explicit owner-approved value. Zero closes spending; no omission-to-unlimited behavior. Token cap amounts are raw-unit integer strings. Missing, invalid, stale, or unbounded valuation denies spending. Preserve configured SpendingPolicy hourly/daily limits and durable spend accounting. PR3 must adapt cluster and amount units explicitly; an EVM-only numeric-chain policy that cannot evaluate Solana must deny, not be silently skipped.

Mony reports that Giacomo gave autonomy without a cap and proposes max-uint like EVM config `9abe5cef` (Mony, 26 Oct 2026). That is an agent report, not Giacomo's approval. This document does not verify that config or adopt its value. Ask Giacomo for the default. Neither fee caps nor a mint allowlist replace that decision.

Config: `tokenCaps`, `maxPerTxUsd`, `price`. Tests: each cap boundary, cumulative debit across instructions, missing cap, absent value-cap setting, unpriced asset, forged decimals, approve above cap, and wSOL double counting in PR3/PR5.

### Replay protection

Keep approval high-water and `used` checks, now keyed by the exact Solana base58 pubkey. Do not lowercase it. Approval sequence stays global to that pubkey across clusters. EVM `txNonces` remains EVM-only; no synthetic Solana transaction nonce is added there.

Recent blockhash: match the message header hash to `tx.recentBlockhash`. Require `isBlockhashValid` and `currentBlockHeight <= lastValidBlockHeight` against the configured cluster. Obtain/verify a trustworthy blockhash-height pair from signer RPC, not just a proposer height. Unknown pairs deny. Recheck immediately before signing. Require `createdAt <= now`, `expiresAt > createdAt`, `expiresAt > now`, and lifetime at most `maxIntentTtlMs`, configured as 120000 and never above 120000 for phase 1. `createdAt >= startedAt` still applies. Do not use the EVM future skew to extend Solana life.

Durable nonce: the message header hash must equal `durableNonce.nonceValue`; fetch the nonce account and check System ownership, initialized state, configured account address, treasury authority, and current value. `AdvanceNonceAccount` must be instruction 0. ComputeBudget instructions follow it; each still appears exactly once. Deny a second advance, a different nonce account/authority/value, or recent-blockhash metadata in this variant. All other instructions obey the same policy. PR4 verifies nonce decoding and simulation behavior without replacing the blockhash.

Add optional version 1 field `solanaMessages`, keyed by pubkey then cluster then lowercase SHA-256 message hash, with `{approvalNonce: string, at: number, nonceAccount?: string, nonceValue?: string}` records. Add optional `solanaNonceValues`, keyed by pubkey/cluster/nonce account with a list of consumed values. The latter denies signing different messages with the same durable nonce value. These fields do not replace `wallets`, `txNonces`, `startedAt`, or `polymarketOrders`. Old files default new maps to empty; malformed new fields deny startup. Keep historical records; no unsafe pruning.

Under the existing request queue and kernel lock, reserve approval nonce, message hash, and durable value together; fsync them before signing or returning a dry-run allow. A crash or audit failure can burn a reservation but must never authorize a retry signature. Deny the same message under a fresh approval nonce, including after restart. Dry-run also consumes the reservation, matching current behavior. A live request after dry-run needs a new message and approval. Lock loss halts both chain families.

Off-chain expiry does not invalidate a durable-nonce transaction already signed. It remains executable until the nonce advances. Restrict nonce accounts, allow only one outstanding message per value, and require Ops to advance/cancel and verify settlement before reuse. Recent-blockhash validity also does not enforce intent expiry on-chain after signing. Proposer must not broadcast after expiry; an on-chain deadline instruction would be a separate design. Do not promise on-chain TTL enforcement.

Config: `nonceAccounts`, `maxIntentTtlMs`, `rpcUrls`. Tests: old version 1 read/write preserves all EVM fields; duplicate message with new approval, expired hash, forged height, stale/different durable value, wrong instruction order, concurrent requests, crash-after-persist, restart, dry-run/live, lock loss, and state rollback deny. PR4 must extend escrow/restore floors to preserve all Solana message hashes and nonce values. Startup refuses an unsafe restore; additive signer fields alone do not make the current restore script compatible.

### Audit chain

Use the same JSONL chain and fixed `AUDIT_ROOT`. Add `cluster`, `messageHash`, `signature`, `programIds`, and either `recentBlockhash` plus `lastValidBlockHeight`, or `nonceAccount` plus `nonceValue`. Keep request id, wallet, approval nonce/hash/signature, mode-related decision, and venue/action. `signature` is the public base58 transaction signature, absent for deny/dry-run. Message hash equals `routeHash`.

Audit allow before returning signed bytes. An audit failure returns no signature and does not roll back replay state. Redact RPC credentials and errors. Never include seed, secret key, private `KeyObject`, bearer token, or full environment. Audit evidence proves a signing decision, not chain settlement. Root compromise and whole-log rollback remain TM-008 risks.

Config: existing `auditLogPath`, `nonceStorePath`, `keyId`. Tests: mixed EVM/Solana chain reload, mutation breaks linkage, no signature on audit failure, new fields present on allow, and secret sentinel absent from all logs in PR4.

### Prediction-market ban

The closed program and mint allowlists already reject unlisted prediction markets. Add built-in program and outcome-mint denials that run before configurable allowlists, at top level and CPI. Config cannot override them. Deny prediction-market venue/action labels, including `polymarket` and known protocol aliases, even under an otherwise valid transaction. Preserve the action enum; label checks alone are insufficient.

Candidate deployments to investigate: Drift/BET prediction markets and Hedgehog Markets. Their prediction-market program ids, deployment status, shared-program implications, and outcome-token mints are **to verify in PR3**. No program id is asserted here. If a protocol shares a program with other products, deny that program in phase 1 rather than infer safety from a label. PR5 rechecks CPI coverage. An unknown or unverifiable mint never enters phase 1. Registry review is required before expanding mints or programs.

Config: no bypass key; `programs`, `innerPrograms`, and `mints` can only narrow the effective policy after hard denials. Tests: attempted config override, relabeled prediction action, denied CPI, outcome mint with an innocent symbol, and a generic transfer of that mint all deny.

## Verifier interface changes Ops must implement

Ops receives the complete canonical proposal, cluster config/revision, treasury pubkey, mode, quote/route evidence, and any ALT hints. It never receives the treasury secret. It independently decodes v0 bytes, resolves ALTs from its RPC, derives account roles and program set, reads mint/token/nonce state, and recomputes SHA-256 `routeHash` and keccak256 JCS `intentHash`.

Run the same action, instruction, mint, owner/ATA, delegate, route, amount, slippage, fee, price, cap, prediction-ban, freshness, and simulation checks. Re-fetch or reconcile the Jupiter quote; do not sign a proposer-supplied `quoteId` as if it authenticated an API response. Display the exact delegate for approve. Compare resolved tables and accounts against the signer's view. Disagreement denies. Verifier approval is necessary; the signer still rechecks state and expiry immediately before signing.

Ops signs the new domain bytes and fills the existing approval fields. It must bind `dry-run`/`live` from signer health and exact cluster. There is no fallback to EVM approval bytes. Transport keeps bearer authentication, body/response caps, timeout, and Unix-socket permissions. The signer does not broadcast; SDK/proposer does so only after response verification.

PR1 introduces a shared JSON test-vector file, proposed path `test/signer/fixtures/solana-approval-vectors.json`. Include raw intent, normalized JCS string, base64 message, route hash, intent hash, domain bytes hex, mode, cluster, public verifier key, signature, and expected decision/error. Use fixed public signatures and public data, with no committed private keys. Include EVM baseline vectors, both-domain negative cases, numeric boundaries, extra fields, NUL, and base58 case changes. PR2/PR5 extend it with ALT and Jupiter fixtures. Both implementations must run identical vectors and publish results before enablement. Ops interface ownership and delivery remain open.

## Config and feature flag

Top-level `solana` is separate from numeric `chains`. An absent object is off. Only `solana.enabled === true` and the selected cluster's `enabled === true` permit requests; `killSwitch === true` wins. Jupiter has a separate off flag. pump.fun/PumpSwap have no phase-1 admission path.

The minimum valid disabled object is `{"solana":{"enabled":false,"clusters":{}}}`. The following is a typed design shape, not an installable config. `required` denotes an Ops or owner value that is not decided here.

```text
solana: {
  enabled: false,
  secretKeyPath?: string,                     // signer-owned file; no secret contents
  clusters: {
    'solana:mainnet': {
      enabled: false,
      killSwitch: false,
      rpcUrls: string[],                      // required before enablement
      rpcQuorum: 2,
      programs: string[],
      innerPrograms: string[],                // no reviewed AMM ids yet
      mints: Record<mint, {symbol: string, decimals: integer, tokenProgram: string}>,
      delegates: string[],                    // empty allows no approve
      nonceAccounts: string[],                // empty allows no durable nonce
      alt: {enabled: false},
      allowWsol: false,
      jupiter: {enabled: false, allowPoolTransfers: false, pools: []},
      fees: {
        maxComputeUnitLimit: required integer,
        maxComputeUnitPriceMicroLamports: required decimal string,
        maxPriorityFeeLamports: "1000000",
        maxFeeUsd: "2",
        maxHeapFrameBytes?: integer,
        maxLoadedAccountsDataSizeBytes?: integer
      },
      maxSlippageBps: 100,
      quoteMaxAgeMs: 30000,
      maxIntentTtlMs: 120000,
      maxPerTxUsd: required USD decimal string, // no decided default
      maxRentLamports: required decimal string,
      tokenCaps: Record<mint | 'native', decimal string>,
      price: {ids: {native: 'solana'}, priceFeed: {provider: 'coingecko', maxAgeMs: 600000},
              bounds: required asset bounds, prices?: asset reference prices}
    },
    'solana:devnet': separate disabled cluster config with fixture mints
  }
}
```

Each future `jupiter.pools` entry must bind `{ammProgram, pool, authority, mintA, mintB, vaultA, vaultB}` as base58 strings; adapter-specific derivation checks prove those relationships. PR5 defines exact supported pool layouts and rejects extra keys. This config list is not a substitute for decoding on-chain pool state.

Phase-1 top-level program config comes from Mony, 26 Oct 2026:

| Program | Address |
| --- | --- |
| Jupiter v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| System | `11111111111111111111111111111111` |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| ComputeBudget | `ComputeBudget111111111111111111111111111111` |

Ops installs config. We never edit live config. The economic defaults above must appear in the reviewed config/template, not hidden fallback constants. Absent numeric policy on an enabled cluster fails startup. The flags themselves default false. A fully absent Solana object neither loads a key nor contacts Solana RPC and preserves EVM startup behavior.

Startup validates exact nested keys, booleans, recognized clusters, canonical pubkeys, non-duplicated lists, decimal quantities, safe counts, wire bounds, positive fee limits, bps range, and lifetime limits. Require mint metadata/caps, SOL pricing bounds/reference, explicit `maxPerTxUsd` and `maxRentLamports`, signer key/pubkey agreement, protected key/state/config paths, and working replay/audit state for enabled clusters. Never fall back to an EVM key, cluster, RPC, cap, or price. Validate RPC cluster genesis identity against independently verified cluster pins (to verify in PR2); do not infer it from the URL. Require at least `rpcQuorum` independent matching RPC views for live operation. Local validator fixtures may explicitly use quorum 1.

Disabled objects must still be well-typed if supplied; readiness checks and key loading apply only to enabled clusters. Reject invalid dormant settings instead of retaining traps for enablement. Missing `jupiter.pools` or reviewed inner programs denies Jupiter enablement. Unconfirmed pool-recipient exceptions cannot be activated by the initial template. A devnet test profile never admits mainnet mints by name. Mainnet and devnet configuration/state lookups remain separate even when the same public key is used. PR1 tests every flag/kill-switch combination and unknown key.

## Dependency choice

| Choice | Tradeoff |
| --- | --- |
| `@solana/kit`, with narrow packages such as `@solana/transactions` and `@solana/codecs` | Recommended for public message parsing, codecs, and RPC composition. Modular imports can limit the signer dependency/bundle surface. Check Node 20.19.2 compatibility and actual transitive graph before selecting a release. Use only the needed packages; do not add both a full umbrella and duplicate alternatives without a consumer. |
| `@solana/web3.js` 1.x | Familiar v0/ALT tooling but maintenance-mode lineage. The December 2024 supply-chain compromise of 1.95.6/1.95.7 is a reason for provenance review and exact pins, not a claim that a later version is automatically safe. Verify the upstream advisory in PR2. Never select those compromised versions. |

Prefer Kit's narrow public-data packages and `node:crypto` signing. Checked on 26 Oct 2026: the latest stable `@solana/kit` is 8.5.0 (published 13 Oct 2026, MIT, `engines.node >=20.18.0`, so the CI floor 20.19.2 qualifies), and Solana's 16 Oct 2026 changelog also lists `@solana/web3.js` 3.1.0. PR2 re-checks both at selection time and reviews the transitive graph of the exact subpackages it imports. The dependency PR must name the reviewed exact versions, use no caret/tilde/range, and pin them and their integrity hashes in both `package-lock.json` and `npm-shrinkwrap.json`. No dependency is added by this PR.

Extend `test/signer/shrinkwrap.test.ts` to cover each selected Solana runtime package and integrity, while retaining byte-for-byte equality with `package-lock.json` and existing EVM pins. Review resolved URLs and transitive imports. Run `scripts/check-audit-regressions.mjs` with complete production audit input; no new ignored finding by default. The existing `reproducible-pack` job must still produce identical tarball SHA-256s from two clean trees.

Measure tsup output for SDK ESM/CJS, MCP, and signer entries before/after. Keep Node 20 target and the current 1,000,000 byte tarball cap. Prefer narrow imports and native crypto over bundling secret-handling adapters. Any externalization must remain installable from the shipped shrinkwrap. PR2 supplies consumer, signer-bin, Linux/macOS, audit, and bundle-size evidence. No build, install, or audit network request runs for this design-only change.

## E2E plan

Gate all external/devnet/local-validator tests with `EVALANCHE_SOLANA_E2E=1`. Default CI runs offline unit tests only for Solana; it does not airdrop, create mints, or send transactions. Runtime fixture keys live in memory or an ephemeral protected test directory, never source control, logs, artifacts, or `.env`. No mainnet transaction ever runs in tests.

The devnet fixture generates its address/key at runtime, funds it by devnet airdrop, and creates an SPL mint with USDC-like decimals as a stand-in. It provisions only the fixture's public address/mint and explicit caps in a devnet signer config. Test-only mint initialization stays outside the production signer instruction allowlist. Verify devnet genesis before any send, reject mainnet genesis, and clean up ephemeral secrets. An airdrop outage reports an unavailable opt-in test; it is not a pass.

Test transfer-to-treasury, external-recipient denial, exact approve/revoke, durable nonce creation by the fixture and signing/advance, expired blockhash, stale quote, duplicate approval, same-message replay under a new approval, restart persistence, and dry-run/live separation. Check confirmed balances, delegate state, nonce state, and transaction errors, not just returned signatures. The ATA-only transfer restriction needs a documented fixture case and Mony's clarification before broadening it.

Jupiter does not run on devnet. Use three separate layers:

1. Recorded mainnet Jupiter quote plus `/swap-instructions` fixtures, with public account/ALT snapshots and provenance. Decoder tests send no transaction and need no network. Test message hashes and all negative mutations.
2. A mocked quote API tests builders, quote age, endpoint failures, missing fields, substituted recipients, and stale responses. Mock success does not prove Jupiter execution.
3. A local validator on the Mac mini, using `solana-test-validator --clone` / `--clone-upgradeable-program`, or a surfpool mainnet fork. Clone JUP6 and one reviewed AMM pool with the program dependencies, vaults, mints, lookup tables, and other required accounts. Exact commands, clone closure, and compatibility are **to verify in PR7**. Remap treasury to fixture keys, preserve needed pool state, and run the reviewed route only against localhost.

The validator/fork harness never runs on the shared Grok Bot box. Firewall/endpoint checks and genesis assertions prevent accidental upstream submission. Fork fetching may read mainnet state in the later opt-in harness; transaction submission is local only. Record decoder, mock, devnet, and local-route results separately. Mainnet readiness still requires Giacomo's decision.

## Phased PR plan

Every PR is TDD-first: failing tests commit, implementation commit, then opt-in E2E evidence for the supported increment. Offline tests remain mandatory. Before PR7, use focused local/devnet probes or recorded fixtures as applicable; report unavailable execution honestly. No PR may turn the incomplete signer on. This phase-0 work makes no commits.

| PR | Scope | Completion evidence |
| --- | --- | --- |
| PR1 | Intent union, strict schema, hashes, Solana approval bytes, shared vectors, flag off. | EVM vectors unchanged. Cross-domain/mode/cluster attacks fail. Absent/off Solana is unreachable and performs no Solana RPC or key load. |
| PR2 | Key custody, install/recovery design, selected pinned public-data dependencies, v0 parsing, static keys and optional ALT resolver. | Native signing vector; secret redaction; protected file tests; wrong signer/header/ALT/genesis tests; Node 20/22 and package/audit/size evidence. No funded key created by this doc. |
| PR3 | System/Token/Token-2022/ATA/ComputeBudget decoders, allowlists, treasury/ATA checks, exact approve/revoke, fee/value/token caps, prediction denials. | Allowed fixtures pass; all forbidden instructions/recipients/extensions fail. Fee rounding/cap boundaries pass. Review actual prediction program ids before admission. |
| PR4 | Blockhash and durable-nonce replay, message/value reservations, additive nonce fields, audit fields, escrow/restore compatibility. | Old version 1 files survive read/write; replay, concurrency, crash, lock, restart, restore-floor, and mixed-audit tests pass. Durable validity limitation documented. |
| PR5 | Jupiter v6 decoder, verified IDL/AMM layouts, quote freshness, slippage, CPI checks, simulation balance deltas. | Recorded reference routes and negative mutations pass. Mony recipient-policy clarification recorded. Unknown variants/unchecked transfers stay denied. No Jupiter enablement until a route satisfies the actual policy. |
| PR6 | SDK/proposer builders, Solana remote client, MCP tools, docs/export parity. | Byte-identical response verification before broadcast; mocked API/transport tests; no private key in proposer; existing EVM tools unchanged; docs/package parity gates pass. |
| PR7 | Reusable opt-in devnet and Mac mini validator/fork E2E harness. | Runtime-only keys, devnet stand-in mint, confirmed transfer/approve/revoke/nonce results, local Jupiter route, and hard mainnet-send rejection. Normal CI remains offline for Solana. |

PRs remain stacked on this branch's signer baseline. Phase 2 adds pump.fun/PumpSwap only after a separate decoder, pool/recipient review, and a dynamic mint allowlist policy agreed with Ops and Mony. It does not reuse an unrestricted Jupiter CPI permission. No merge, tag, release, live config install, or mainnet activation without Giacomo's approval. PR #22 is not modified or included.

## Threat model deltas

These are proposed additions to `evalanche-threat-model.md`, not edits to that file. IDs follow the existing TM-001 through TM-008 series and must be checked for collisions in the implementation PR. Existing controls are absent for Solana in phase 0. The columns match the current threat table.

| Threat ID | Threat source | Prerequisites | Threat action | Impact | Impacted assets | Existing controls (evidence) | Gaps | Recommended mitigations | Detection ideas | Likelihood | Impact severity | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TM-009 | Proposer or RPC | v0 lookup tables enabled | Substitute table expansion, slot, or indices | Redirect account access/funds | Treasury tokens | None for Solana; proposed PR2 | Mutable RPC/table state | Static keys first; independently fetch/compare table snapshots and used entries; reject ambiguity | Audit ALT hashes/context disagreement | Medium | High | High |
| TM-010 | Route API or upgradeable program | Jupiter/CPI admitted | Invoke unknown AMM or hidden transfer | Fund loss | Tokens and SOL | None for Solana; proposed PR3/PR5 | Program ids alone do not prove semantics; upgrades and simulation drift remain | Inner allowlist plus route/account decoders, reviewed program deployment changes, complete CPI trace | Unexpected CPI/pool/upgrade alerts | Medium | High | High |
| TM-011 | Malicious mint issuer | Token-2022 admitted | Hook, delegate, fee, or confidential extension changes spend | Hidden debit or authority | Tokens/allowances | None for Solana; proposed PR3 | Unknown TLV/extension interactions | Deny extension-bearing mints/accounts in phase 1 | Extension rejection counters | Medium | High | High |
| TM-012 | Signed-transaction holder | Durable nonce transaction signed | Broadcast after off-chain expiry or replay altered proposal | Long-lived spend authority | Treasury funds/replay state | EVM nonce/flock machinery only; proposed PR4 | Approval expiry is not on-chain invalidation | Nonce allowlist, value reservation, one outstanding message/value, advance/cancel verification, restore floors | Outstanding nonce age and duplicate value alerts | Medium | High | High |
| TM-013 | Approved delegate | Exact allowance exists | Spend later or after failed swap | Token loss up to allowance | Treasury token balance | None for Solana; proposed PR3 | Approval TTL does not expire allowance | Exact approveChecked, delegate allowlist, no max-u64, revoke leftovers | Poll delegated amount and age | Medium | High | High |
| TM-014 | Proposer/route API | closeAccount or ATA setup accepted | Redirect rent or close unrelated account | SOL theft/account disruption | Rent reserves and token accounts | None for Solana; proposed PR3 | Native/token accounting can diverge | Treasury close authority/destination, wSOL-only close, derived ATA and rent bounds | Unexpected closures/rent deltas | Medium | High | High |
| TM-015 | Compromised RPC | Signer trusts RPC account/simulation data | Hide CPI, fabricate balances, fork or stale state | Unsafe message appears valid | Funds and policy evidence | EVM RPC path exists; no Solana quorum yet | Multiple providers can collude; state may change after simulation | Independent RPC quorum, matching snapshots/genesis, fail on disagreement, static decoding, fresh rechecks | Slot/account/simulation mismatch alerts | Medium | High | High |
| TM-016 | Proposer or blockhash source | Many candidate messages/approvals | Blockhash grinding: vary messages or choose a stale fork for favorable execution | Bypass message-only replay assumptions; repeated economic exposure | Spend budgets and replay records | Approval high-water can be reused; proposed PR4/PR5 | New blockhash changes hash; no fair-ordering guarantee | Fresh signer-validated hash, intent/approval reauthorization, gross spend caps/budgets, no blind refresh/retry | Repeated quote/intent with varied hashes, expiry denials | Medium | High | High |

TM-008 remains open for this chain. Root can read keys, replace policy, or roll back both audit and replay state. RPC quorum is defense against one provider, not proof of chain truth. Simulation is evidence about one bank state, not a guarantee of future execution. Mints/programs can change behavior through authorities or upgrades; rollout review must record that residual risk.

## Open questions

### For Mony

- Confirm the proposed exact schema: outer EVM aliases absent; `slippageBps == maxSlippageBps`; quote id provenance; `programIds` includes CPI; exact-in only at initial enablement; approve delegate is message-bound rather than a new intent field.
- Does `transfer` mean intra-treasury token-account/ATA moves? Which distinct source accounts must it support under an ATA-only destination rule?
- Confirm whether validated AMM pool input transfers may be exempt from the literal all-recipients-treasury rule. Without that change, Jupiter swaps remain denied. Are routes that use unchecked SPL transfers required? Those remain denied pending a separately specified safe decoder policy.
- Supply reference venues, AMM routes/pools, quote and swap-instruction fixtures, and required shared-account or v2 variants. Do any routes work within the phase-1 mint and instruction restrictions?
- Supply the treasury public address after Ops creates it. No placeholder address should become a config value.
- Define the phase-2 dynamic mint-list admission, removal, authority/extension screening, and owner policy with Ops.
- Are static-key-only v0 messages without ALTs acceptable for phase 1? Which routes would that exclude?
- Which Jupiter API tier, endpoint, authentication custody, and rate limits should the proposer/verifier use? Confirm the deployed v6 API/IDL reference in PR5.

### For Ops

- Own and implement the verifier interface, new approval bytes, same-policy execution, RPC/account snapshot reconciliation, quote revalidation, and shared-vector test runner. How will config revisions and discrepancies be surfaced?
- Choose protected init-file custody or the env alternative. Confirm install-time generation, public-key delivery, backup/recovery, and shared-box root exposure. How will a reset recover the key without export to an agent-readable escrow?
- Choose ALT policy and resolution provider/snapshot mechanism. Can matching bank contexts be obtained? If not, keep ALTs off.
- Choose independent RPC providers, quorum, cluster genesis pins, commitment/context policy, and timeouts. Set explicit CU count/price and rent-related review bounds.
- Create/allowlist durable nonce accounts outside the production signing action set. Who advances/cancels outstanding values and verifies settlement? Extend escrow/restore floors for the new state.
- Install the reviewed disabled config and later owner-approved values. Supply token caps, SOL/token price bounds, approved delegates, reviewed CPI programs/pools, and evidence that startup/kill switches fail closed. Do not activate unresolved recipient exceptions.

### For Giacomo

- Decide the per-transaction value-cap default and unit/policy. `maxPerTxUsd` has no default in this design. Mony's agent-reported no-cap/max-uint claim is not treated as authorization.
- Approve or decline mainnet enablement after verifier, custody, RPC, decoder, replay/restore, E2E, and TM-008 evidence is reviewable. No mainnet transaction, merge, tag, or release proceeds without that approval.
