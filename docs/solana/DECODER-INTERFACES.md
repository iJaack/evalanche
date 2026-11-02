# Solana decoder interfaces (extract for verifier-sol.cjs)

Version: **v1.1** (2026-11-01). This file follows `docs/solana/PR3-SPEC.md` v1.1.

This is a short extract of `PR3-SPEC.md`, for Ops' independent `verifier-sol.cjs`. The signer will export these names from `evalanche` once PR3 lands. They are not exported yet. The verifier writes its own decoder and must produce **identical** JSON for the shared vectors.

## Input

- The unsigned v0 message bytes (`tx.serializedMessage`, canonical base64).
- Phase 1 rules: static keys only (any ALT denies), exactly 1 required signer (the treasury, index 0, writable), no trailing bytes. These are already enforced by `parseSolanaMessage`.

## Decoded action JSON (`DecodedSolanaActionJson`)

Integers that can exceed 2^53 are canonical decimal strings. Each object is serialized with JCS (sorted keys).

```ts
type B58 = string; type U64 = string; // decimal, no leading zeros
type TokenProgramId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' | 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
interface Base { instructionIndex: number; programId: B58 }
type DecodedSolanaActionJson =
  | Base & { kind: 'computeBudget.setComputeUnitLimit'; units: number }
  | Base & { kind: 'computeBudget.setComputeUnitPrice'; microLamports: U64 }
  | Base & { kind: 'system.transfer'; from: B58; to: B58; lamports: U64 }
  | Base & { kind: 'token.transferChecked'; tokenProgram: TokenProgramId; source: B58; mint: B58; destination: B58; authority: B58; amount: U64; decimals: number }
  | Base & { kind: 'token.approveChecked'; tokenProgram: TokenProgramId; source: B58; mint: B58; delegate: B58; owner: B58; amount: U64; decimals: number }
  | Base & { kind: 'token.revoke'; tokenProgram: TokenProgramId; source: B58; owner: B58 }
  | Base & { kind: 'token.closeAccount'; tokenProgram: TokenProgramId; account: B58; destination: B58; owner: B58 }
  | Base & { kind: 'token.syncNative'; tokenProgram: TokenProgramId; account: B58 }
  | Base & { kind: 'ata.create'; mode: 'create' | 'createIdempotent'; payer: B58; ata: B58; wallet: B58; mint: B58; tokenProgram: TokenProgramId; impliedCpiPrograms: [B58, TokenProgramId] };
```

## Instructions that decode

Every other instruction denies.

| Program | Data | Accounts (flags) |
|---|---|---|
| ComputeBudget | `02`+u32 (5 B), `03`+u64 (9 B), each exactly once | none |
| System | u32 `2` + u64 (12 B) | from (signer, w), to (w) |
| Token (SPL Token only; Token-2022 is denied as a whole program, `SOL_DENY_PROGRAM_NOT_ENABLED`, with no extension checks) | `0c`+u64+u8 TransferChecked | source w, mint, destination w, authority signer |
| | `0d`+u64+u8 ApproveChecked | source w, mint, delegate, owner signer |
| | `05` Revoke | source w, owner signer |
| | `09` CloseAccount | account w, destination w, owner signer |
| | `11` SyncNative | account w |
| ATA | empty or `00` Create, `01` CreateIdempotent | payer (signer, w), ata w, wallet, mint, System, token program (Token; Token-2022 → `SOL_DENY_PROGRAM_NOT_ENABLED` before structure) |

- Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`): any instruction → `SOL_DENY_PROGRAM_NOT_ENABLED`, checked before structure. `TokenProgramId` keeps the Token-2022 id only for type completeness.
- Jupiter and any other unknown top-level program → `SOL_DENY_PROGRAM_UNKNOWN` at decode (Jupiter arrives in PR5). A `swap` intent → `SOL_DENY_PROGRAM_NOT_ENABLED`.
- Data length, account count and each signer/writable flag are exact.
- Decoded fields must re-encode to the identical data bytes.
- ATA derivation seeds are `[wallet, tokenProgram, mint]` under `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
- `programIds` must equal the sorted union of the top-level programs and each `ata.create.impliedCpiPrograms` (System and the token program).

## Policy (summary)

- Treasury-only recipients and authorities.
- Mints only from config, a subset of wSOL, USDC and USDT on mainnet.
- Exact approve to an allowlisted delegate. Revoke is always allowed.
- Wrap: an optional wSOL ATA create, a System transfer to the treasury wSOL ATA, then syncNative. Requires `allowWsol`.
- Unwrap or close: closeAccount of a treasury ATA, with destination and owner both the treasury. For wSOL, `amountIn` is the exact wSOL ATA balance: PR3 checks presence and format (canonical u64), and PR4 proves the balance. Non-wSOL needs `amountIn` `"0"`.
- An ATA create needs the treasury as payer and wallet, plus the derived address.
- Caps: no defaults. Every cap is required in config. These code values are hard ceilings, and config may not exceed them (`SOL_DENY_CONFIG_ABOVE_CEILING`):
  - CU ≤ 400,000;
  - price ≤ 2,500,000 µlamports;
  - priority fee ≤ 1,000,000 lamports;
  - rent ≤ 3,000,000 lamports;
  - `maxFeeUsd` ≤ 2.00 (required; there is no 0.50 default);
  - `tokenCaps` per mint and `native`, plus `maxPerTxUsd`, required with no default.
- Jupiter is `SOL_DENY_PROGRAM_UNKNOWN` at decode until PR5. Drift BET and Hedgehog are **TO VERIFY, not enforced**. Their program ids are `null` in `SOLANA_HARD_DENIED_PROGRAMS`, so nothing matches them yet. Only `verified` entries deny with `SOL_DENY_PROGRAM_HARD_DENIED`. Today both are excluded anyway by the closed program allowlist (`SOL_DENY_PROGRAM_UNKNOWN`).

## Deny reasons

Stable strings. The message format is `<REASON>: <public detail>`.

```
SOL_DENY_PROGRAM_UNKNOWN  SOL_DENY_PROGRAM_NOT_ENABLED  SOL_DENY_PROGRAM_HARD_DENIED  SOL_DENY_PROGRAM_IDS_MISMATCH
SOL_DENY_ACCOUNT_COUNT  SOL_DENY_ACCOUNT_FLAGS  SOL_DENY_DATA_LENGTH  SOL_DENY_NONCANONICAL_DATA
SOL_DENY_COMPUTE_BUDGET_INSTRUCTION  SOL_DENY_COMPUTE_BUDGET_CARDINALITY  SOL_DENY_COMPUTE_BUDGET_MISMATCH  SOL_DENY_COMPUTE_BUDGET_CAP
SOL_DENY_DURABLE_NONCE  SOL_DENY_SYSTEM_INSTRUCTION
SOL_DENY_TOKEN_UNCHECKED  SOL_DENY_TOKEN_INSTRUCTION  SOL_DENY_TOKEN_INIT_OUTSIDE_ATA  SOL_DENY_TOKEN2022_EXTENSION  SOL_DENY_TOKEN_PROGRAM_MISMATCH
SOL_DENY_ATA_INSTRUCTION  SOL_DENY_ATA_DERIVATION  SOL_DENY_ATA_OWNER_NOT_TREASURY
SOL_DENY_MINT_NOT_ALLOWED  SOL_DENY_DECIMALS_MISMATCH
SOL_DENY_RECIPIENT_NOT_TREASURY  SOL_DENY_AUTHORITY_NOT_TREASURY  SOL_DENY_SELF_TRANSFER_NOOP
SOL_DENY_DELEGATE_NOT_ALLOWED  SOL_DENY_APPROVE_AMOUNT  SOL_DENY_WSOL_DISABLED
SOL_DENY_UNEXPECTED_ACTION  SOL_DENY_ACTION_MISMATCH  SOL_DENY_AMOUNT_MISMATCH
SOL_DENY_CAP_MISSING  SOL_DENY_TOKEN_CAP  SOL_DENY_CONFIG_ABOVE_CEILING
SOL_DENY_ACTIONS_MISMATCH  SOL_DENY_CLUSTER_MISMATCH
```

There are 38 reasons. `SOL_DENY_TOKEN2022_EXTENSION` is reserved and not emitted in PR3. `SOL_DENY_ACTION_MISMATCH` means only a step-7 shape mismatch. `SOL_DENY_ACTIONS_MISMATCH` and `SOL_DENY_CLUSTER_MISMATCH` never carry an `instructionIndex`.

PR4 adds the following reasons: `SOL_DENY_FEE_USD_CAP`, `SOL_DENY_FEE_UNAVAILABLE`, `SOL_DENY_RENT_CAP`, `SOL_DENY_PER_TX_USD` and `SOL_DENY_PRICE_UNAVAILABLE`, plus blockhash and simulation reasons.

The order of checks is fixed:

1. In `decodeSolanaMessage` (in the policy this is step 1a, after hard denials and the handed-actions copy):
   1. hard-denied programs;
   2. `AdvanceNonceAccount` anywhere;
   3. per instruction, in index order;
   4. ComputeBudget cardinality.
2. In `assertSolanaActionsAllowed`, numbered as in `PR3-SPEC.md` §6.1:
   1. Hard denials: first over the signed message, then the handed-actions copy, then over the copy. Malformed handed input gives `SOL_DENY_ACTIONS_MISMATCH` with no index and never a fallback. It **wins over decoder errors**: `null` actions with a nonce message give `ACTIONS_MISMATCH`.
   - 1a. Own decode of `intent.tx.serializedMessage`. Its errors keep their own reason and index.
   - 1b. The handed actions must equal the own decode exactly (order, JS types, exact field set; no sorting). Otherwise `SOL_DENY_ACTIONS_MISMATCH`, with no index.
   - 1c. `intent.chainId` must equal the context cluster. Otherwise `SOL_DENY_CLUSTER_MISMATCH`, with no index.
   2. payer and wallet;
   3. `programIds`;
   4. program enablement;
   5. ComputeBudget values and caps;
   6. recipients and authorities;
   7. action shape;
   8. mints (wSOL decimals must be 9 in registry and intent, else `SOL_DENY_DECIMALS_MISMATCH`);
   9. caps.

   Steps 2–9 use only the own decode. An invalid base64 message, which makes the parser throw a plain `Error`, is deferred to PR4.

**Handed-actions object form** (any break, or any exception while reading it, gives `SOL_DENY_ACTIONS_MISMATCH` with no index, and no user code runs):

- **Arrays** (the outer list and every nested array, such as `impliedCpiPrograms`):
  - `Array.isArray`, and the prototype is exactly this realm's `Array.prototype`. Subclasses, null-prototype arrays, arrays re-prototyped to `Object.prototype`, and cross-realm (`vm`) arrays are rejected.
  - No own keys besides canonical indices and `length`. Symbols, `Symbol.iterator` included, are rejected.
  - No holes.
  - Elements are read only through own data descriptors with index loops. The array is never iterated.
- **Actions:** plain objects whose prototype is exactly `Object.prototype`, with own string-keyed data properties only. Values are primitives, except `impliedCpiPrograms`.
- **Accessors** (on arrays or actions) are rejected without being called.
- **Proxies** (list, nested arrays or actions) are rejected before any trap can run.

The verifier must report the same first reason.

## Shared vector files (in the evalanche repo)

- `test/signer/fixtures/solana-approval-vectors.json`: exists now (PR1). Approval bytes and hashes.
- `test/signer/fixtures/solana-decode/mainnet-messages.json`: PR3. Recorded mainnet messages with signature and slot.
- `test/signer/fixtures/solana-decode/handbuilt-negatives.json`: PR3. One mutation each, with the expected reason.
- `test/signer/fixtures/solana-decode/policy-vectors.json`: PR3. `{id, provenance, signature?, slot?, messageHex, intent, configProfile, expected: {actions} | {deny, instructionIndex?}}`.
- Candidate source, before TDD curates it: `/workspace/evalanche-sol-1.18/mainnet-vector-candidates.json` (on the box). Fetched read-only from `solana-rpc.publicnode.com` on 1 Nov 2026.

## Amendment log

- v1.1, 2026-11-01, approved by Builder under Giacomo's 2026-10-26 'vai autonomamente' rule for evalanche Solana (tightening only). Adds `SOL_DENY_ACTIONS_MISMATCH` and `SOL_DENY_CLUSTER_MISMATCH` (38 reasons), the new order and the malformed-input rule, and wSOL decimals 9. The verifier must bind its input actions to its own decode the same way.
- v1.1 doc corrections, 2026-11-01, approved by Builder under the same rule (no new reason):
  - Token-2022 is denied as a whole program, with no extension checks.
  - All defaults are removed (`maxFeeUsd` 0.50 included). Caps are required and the code values are hard ceilings, with `maxFeeUsd` ≤ 2.00.
  - The handed-actions object form is spelled out, and malformed input wins over decoder errors.
  - wSOL unwrap is the exact balance (format checked in PR3, balance in PR4).
  - Jupiter is `PROGRAM_UNKNOWN` in PR3.
- v1.1 doc corrections (2), 2026-11-01, approved by Builder under the same rule (tightening and consistency only, no new reason):
  - Handed arrays must have exactly this realm's `Array.prototype`.
  - The array shape is documented.
  - The step numbering is aligned with PR3-SPEC §6.1 (1, 1a–1c, 2–9).
  - Drift BET and Hedgehog are TO VERIFY, not enforced (ids are `null`).
  - Invalid base64 is deferred to PR4.
