# PR3 spec: Solana instruction decoders and action policy (evalanche 1.18)

Version: **v1.1** (2026-11-01). See the amendment log at the end.

Status: v1.1. Implemented in #40 on top of TDD's tests (#39, ec122db, 15d0a63). Next: TDD verifies, then E2E. Not merged.

- Base: `feat/solana-1.18` at `1d3be87` (release/1.17.0 + CCTP + 1.17.0-rc.8 + Solana PR1/PR2 + PR0 tarball cap 1,500,000).
- Grounding:
  - `docs/solana-support.md`: §Instruction decoders, §Mint allowlist, §Transfer action, §Exact SPL approve and revoke, §Fee caps, §Token caps, §Prediction-market ban, §Phased PR plan.
  - `src/signer/solana-intent.ts`: `parseSolanaMessage`, `assertSolanaMessageMatchesIntent`, `solanaPriorityFeeLamports`.
  - `src/signer/solana-policy.ts`: `resolveSolanaConfig`, `assertSolanaClusterReady`, `SOLANA_PHASE1_*`.

## 0. Scope

In PR3:

- Pure, offline, synchronous decoders for every top-level instruction of a message already accepted by `parseSolanaMessage`. That message is v0 with static keys only, exactly 1 required signer (the treasury at index 0), no ALTs and no trailing bytes.
- A closed `DecodedSolanaAction` union.
- `assertSolanaActionsAllowed(actions, config, intent)` with a fixed deny-reason catalog.
- The `programIds` derivation and equality check.
- Mint allowlist and treasury-only recipient rules.
- Token and native caps, and the `maxPerTxUsd` shape (raw-unit checks here; USD valuation is wired in PR4).
- Hard prediction-market denials: the table only. The IDs are TO VERIFY (`null`), so these entries are not enforced yet.
- Message-level `AdvanceNonceAccount` rejection. This is the doc's open PR2 item.
- Token-2022 is denied as a whole program in phase 1 (`SOL_DENY_PROGRAM_NOT_ENABLED`, v1.1). There is no extension checker and there are no extension checks in PR3.

Not in PR3:

- RPC, simulation, CPI traces, blockhash validity, fee-for-message, prices.
- Replay and audit.
- Custody, signing, Jupiter (PR5).
- Lifting the PR1 startup or request gate. `server.ts:570`, `:594` and `:1572` stay as they are. No network, no key file, no new dependency.

## 1. File layout

```
src/signer/solana-decode/
  constants.ts      program ids, instruction tags, sizes, SOLANA_PHASE1_CEILINGS (hard ceilings, no defaults), hard-deny table
  errors.ts         SolanaDenyReason union, SolanaPolicyDenial class, deny()
  accounts.ts       account-role table from the v0 header (signer / writable per static index)
  compute-budget.ts decodeComputeBudget (moves PR2's inline loop here; PR2 API unchanged)
  system.ts         decodeSystem
  token.ts          decodeToken (SPL Token only; any Token-2022 instruction -> SOL_DENY_PROGRAM_NOT_ENABLED before structure)
  ata.ts            decodeAta + deriveTreasuryAtas (async, @solana/addresses) + TreasuryAtaMap
  decode.ts         decodeSolanaMessage(parsed) -> DecodedSolanaAction[]; derivedProgramIds()
  policy.ts         assertSolanaActionsAllowed(actions, config, intent); debit summary
  index.ts          re-exports (also re-exported from src/signer/index.ts and src/index.ts, as PR2 did)
test/signer/solana-decode/*.test.ts
test/signer/fixtures/solana-decode/{mainnet-messages.json, handbuilt-negatives.json, policy-vectors.json}
```

`assertSolanaMessageMatchesIntent` keeps its signature and error strings. Internally it calls `decodeComputeBudget`, so the PR2 tests stay green unchanged.

## 2. Shared types

```ts
import type { ParsedSolanaMessage, SolanaSigningIntent, SolanaChainId } from '../solana-intent';
import type { ResolvedSolanaCluster } from '../solana-policy';

export type Base58 = string;               // canonical 32-byte base58 (validated by decodeBase58)

export interface MessageAccount {
  index: number;
  address: Base58;
  signer: boolean;                         // index < header.numRequiredSignatures
  writable: boolean;                       // signer: index < numRequiredSignatures - numReadonlySignedAccounts
                                           // unsigned: index < keys.length - numReadonlyUnsignedAccounts
}

export interface DecodeInstructionInput {
  message: ParsedSolanaMessage;            // already passed parseSolanaMessage
  accounts: readonly MessageAccount[];     // from accountRoles(message)
  instructionIndex: number;
  instruction: ParsedSolanaMessage['instructions'][number];
}

export type TokenProgramId =
  | 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  | 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
```

`accountRoles(message): MessageAccount[]` is pure. Because PR2 enforces `numRequiredSignatures === 1` and `numReadonlySignedAccounts === 0`, the treasury is the only signer and is writable. Decoders must still check the flags of every account they consume, and never assume them.

## 3. DecodedSolanaAction (closed discriminated union)

Amounts are `bigint` in TS. The JSON form for vectors and the verifier uses canonical decimal strings (§12).

```ts
interface ActionBase { instructionIndex: number; programId: Base58 }

export type DecodedSolanaAction =
  | (ActionBase & { kind: 'computeBudget.setComputeUnitLimit'; units: number })                // tag 2, data len 5 (u32 LE)
  | (ActionBase & { kind: 'computeBudget.setComputeUnitPrice'; microLamports: bigint })         // tag 3, data len 9 (u64 LE)
  | (ActionBase & { kind: 'system.transfer'; from: Base58; to: Base58; lamports: bigint })      // u32 tag 2, data len 12
  | (ActionBase & { kind: 'token.transferChecked'; tokenProgram: TokenProgramId;                 // tag 12, data len 10
      source: Base58; mint: Base58; destination: Base58; authority: Base58; amount: bigint; decimals: number })
  | (ActionBase & { kind: 'token.approveChecked'; tokenProgram: TokenProgramId;                  // tag 13, data len 10
      source: Base58; mint: Base58; delegate: Base58; owner: Base58; amount: bigint; decimals: number })
  | (ActionBase & { kind: 'token.revoke'; tokenProgram: TokenProgramId; source: Base58; owner: Base58 })          // tag 5, len 1
  | (ActionBase & { kind: 'token.closeAccount'; tokenProgram: TokenProgramId;                    // tag 9, len 1
      account: Base58; destination: Base58; owner: Base58 })
  | (ActionBase & { kind: 'token.syncNative'; tokenProgram: TokenProgramId; account: Base58 })  // tag 17, len 1
  | (ActionBase & { kind: 'ata.create'; mode: 'create' | 'createIdempotent';                     // data [] or [0] / [1]
      payer: Base58; ata: Base58; wallet: Base58; mint: Base58; tokenProgram: TokenProgramId;
      impliedCpiPrograms: readonly [Base58 /* System */, TokenProgramId] });
```

There is no `token.initializeAccount3` action at top level. Per the doc, `initializeAccount3` is legal only as a CPI inside an ATA creation. The ATA program performs that CPI, and PR4 checks it in the simulation trace. A top-level tag 18 is denied with `SOL_DENY_TOKEN_INIT_OUTSIDE_ATA`.

### 3.1 Decoder signatures

```ts
export function accountRoles(message: ParsedSolanaMessage): MessageAccount[];
export function decodeComputeBudget(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: `computeBudget.${string}` }>;
export function decodeSystem(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: 'system.transfer' }>;
export function decodeToken(i: DecodeInstructionInput):
  Extract<DecodedSolanaAction, { kind: `token.${string}` }>;
export function decodeAta(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: 'ata.create' }>;
/** Dispatch on programId; unknown program -> SOL_DENY_PROGRAM_UNKNOWN. Also enforces the
 *  ComputeBudget cardinality (exactly one limit + one price) and AdvanceNonceAccount anywhere. */
export function decodeSolanaMessage(message: ParsedSolanaMessage): DecodedSolanaAction[];  // structure only; needs no treasury or config
/** Sorted, de-duplicated union of top-level program ids and each ata.create's impliedCpiPrograms. */
export function derivedProgramIds(message: ParsedSolanaMessage, actions: readonly DecodedSolanaAction[]): Base58[];
```

Every decoder throws `SolanaPolicyDenial` (§7) and never returns a partial result. Every decoder checks:

1. exact data length;
2. exact account count;
3. each account's signer and writable flags against the table below;
4. a re-encode of the decoded fields that is byte-identical to `instruction.data`.

### 3.2 Instruction table (layouts to re-verify against pinned official sources in PR3; recorded mainnet bytes in §11 already match)

| Program | Tag / data | Accounts (exact count, flags) | Decision |
|---|---|---|---|
| ComputeBudget `ComputeBudget111…` | `02` + u32 units (5 B) | 0 accounts | allow, exactly once |
| | `03` + u64 µlamports (9 B) | 0 | allow, exactly once |
| | `00` RequestUnits (deprecated), `01` RequestHeapFrame, `04` SetLoadedAccountsDataSizeLimit, other | – | deny `SOL_DENY_COMPUTE_BUDGET_INSTRUCTION` (no config key) |
| System `1111…1111` | u32 LE `2` Transfer + u64 lamports (12 B) | 2: from (signer, writable), to (writable) | decode; policy decides |
| | u32 `4` AdvanceNonceAccount, at any position | – | deny `SOL_DENY_DURABLE_NONCE` (checked before other System decoding) |
| | u32 `0` CreateAccount, `1` Assign, `3` CreateAccountWithSeed, `5` WithdrawNonce, `6` InitializeNonce, `7` AuthorizeNonce, `8` Allocate, `9` AllocateWithSeed, `10` AssignWithSeed, `11` TransferWithSeed, `12` UpgradeNonceAccount, other | – | deny `SOL_DENY_SYSTEM_INSTRUCTION` |
| Token-2022 `Tokenz…` | any instruction | – | deny `SOL_DENY_PROGRAM_NOT_ENABLED` (whole program, checked before any structural check; v1.1) |
| SPL Token `Tokenkeg…` | `0C` TransferChecked + u64 + u8 (10 B) | 4: source (w), mint (ro), destination (w), authority (signer). No extra multisig signers | decode |
| | `0D` ApproveChecked + u64 + u8 (10 B) | 4: source (w), mint (ro), delegate (ro), owner (signer) | decode |
| | `05` Revoke (1 B) | 2: source (w), owner (signer) | decode |
| | `09` CloseAccount (1 B) | 3: account (w), destination (w), owner (signer) | decode |
| | `11` SyncNative (1 B) | 1: account (w) | decode |
| | `12` InitializeAccount3 (33 B) at top level | – | deny `SOL_DENY_TOKEN_INIT_OUTSIDE_ATA` |
| | `03` Transfer, `04` Approve (unchecked) | – | deny `SOL_DENY_TOKEN_UNCHECKED` |
| | `06` SetAuthority, `07` MintTo, `08` Burn, `0A` Freeze, `0B` Thaw, `0E` MintToChecked, `0F` BurnChecked, `00/01/02/10/13/14` initializers, `15–18` utility ops, other | – | deny `SOL_DENY_TOKEN_INSTRUCTION` |
| ATA `ATokenGP…` | empty or `00` Create, `01` CreateIdempotent | 6: payer (signer, w), ata (w), wallet (ro), mint (ro), system program (ro, == System), token program (ro, Token; Token-2022 here -> `SOL_DENY_PROGRAM_NOT_ENABLED` before structure) | decode |
| | `02` RecoverNested, other | – | deny `SOL_DENY_ATA_INSTRUCTION` |
| any other program id | – | – | deny `SOL_DENY_PROGRAM_UNKNOWN` (Jupiter included: top-level Jupiter is `SOL_DENY_PROGRAM_UNKNOWN` in PR3; Jupiter arrives in PR5) |

Notes:

- The hex tags in the Token rows are the 1-byte instruction discriminator (`0x0C` = 12, `0x0D` = 13, `0x11` = 17, `0x12` = 18).
- Token-2022 is denied as a whole program in phase 1 (`SOL_DENY_PROGRAM_NOT_ENABLED`, v1.1): every Token-2022 instruction, and an ATA create whose token program is Token-2022. No Token-2022 tag table and no extension boundary apply in PR3.

## 4. ComputeBudget (moved, unchanged semantics)

- Exactly one `setComputeUnitLimit` and one `setComputeUnitPrice` per message. Their position is free; real wallets emit both orders (vectors R1 and R2).
- Both values must equal the intent (`tx.computeUnitLimit`, `tx.computeUnitPriceMicroLamports`). The limit must be ≥ 1.
- Caps: `units ≤ fees.maxComputeUnitLimit`, `µlamports ≤ fees.maxComputeUnitPriceMicroLamports`, and `solanaPriorityFeeLamports(units, price) ≤ fees.maxPriorityFeeLamports`.
- There are no defaults (v1.1). `maxComputeUnitLimit`, `maxComputeUnitPriceMicroLamports` and `maxPriorityFeeLamports` are required in config, else `SOL_DENY_CAP_MISSING`. The code values are hard ceilings (§6.6). At the ceilings, 400,000 × 2,500,000 / 10⁶ = 1,000,000, so the ceiling pair sits exactly at the priority-fee ceiling. A vector one µlamport above the price cap must deny.

## 5. ATA derivation via @solana/addresses

```ts
export type TreasuryAtaMap = ReadonlyMap<Base58 /* mint */, { ata: Base58; tokenProgram: TokenProgramId }>;
/** Startup-time, async. Seeds: [treasury, tokenProgram, mint] under the ATA program. */
export async function deriveTreasuryAtas(treasury: Base58, mints: Record<Base58, { tokenProgram: TokenProgramId }>): Promise<TreasuryAtaMap>;
export function treasuryAtaOwnerOf(map: TreasuryAtaMap, account: Base58): Base58 | undefined; // reverse lookup -> mint
```

- Implementation:
  - `getProgramDerivedAddress({ programAddress: ATA, seeds: [enc.encode(treasury), enc.encode(tokenProgram), enc.encode(mint)] })`, with `enc = getAddressEncoder()`, both from `@solana/addresses@8.5.0` (already pinned, first import).
  - Uses WebCrypto SHA-256 (Node 20 global) and the package's off-curve check.
  - The bump is not needed, but the vector records it.
- Verified on 1 Nov 2026 against mainnet tx R3: USDC ATA `HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq`, derived match, bump 255.
- The map is computed once when the cluster resolves, keeping the decoders synchronous. PR4 wires it into startup.
- `tsup` keeps `dependencies` external, so the import adds no bundle bytes. The package resolves at runtime from the shipped shrinkwrap.
- `decodeAta` checks structure only:
  - 6 accounts with the flags in §3.2;
  - account 4 is System;
  - account 5 is Token (Token-2022 -> `SOL_DENY_PROGRAM_NOT_ENABLED`, checked first);
  - data is empty, `00` or `01`.

  It does not judge ownership, so a third-party ATA create (R3) still decodes. Policy then requires:
  - `payer === wallet === treasury` (step 6, `SOL_DENY_ATA_OWNER_NOT_TREASURY`);
  - `mint` allowlisted and `tokenProgram === mints[mint].tokenProgram` (step 8);
  - `ata === treasuryAtas.get(mint).ata` (step 8, `SOL_DENY_ATA_DERIVATION`).

  All decoders follow the same split: decoders reject malformed or forbidden *instructions*, and policy rejects disallowed *parties and values*.

## 6. Policy

```ts
export interface SolanaPolicyContext {
  cluster: SolanaChainId;
  config: ResolvedSolanaCluster;           // after assertSolanaClusterReady
  treasury: Base58;
  treasuryAtas: TreasuryAtaMap;
}
/** Throws SolanaPolicyDenial with the first failing reason. Pure; no RPC. */
export function assertSolanaActionsAllowed(
  actions: readonly DecodedSolanaAction[],
  config: SolanaPolicyContext,
  intent: SolanaSigningIntent,
): SolanaDebitSummary;

export interface SolanaDebitSummary {
  /** Gross authorized raw-unit debit per mint, plus 'native' lamports (principal only). */
  debits: Readonly<Record<Base58 | 'native', bigint>>;
  /** New accounts this message may create; PR4 prices rent via RPC and enforces maxRentLamports. */
  newAccounts: ReadonlyArray<{ address: Base58; tokenProgram: TokenProgramId; expectedSpace: 165 | 170 }>;
  priorityFeeLamports: bigint;
}
```

### 6.1 Order of checks (first failure wins; the order is part of the contract and is tested)

Inside `decodeSolanaMessage` (standalone, or as step 1a of the policy) checks fail in this order:

- (a) a pre-pass over all top-level program ids for hard denials (§8);
- (b) a pre-pass for System `AdvanceNonceAccount` at any index;
- (c) per-instruction decoding (hard-deny table is static code, so no config is needed) in index order, where an unknown program or a denied instruction throws at its index;
- (d) ComputeBudget cardinality.

`assertSolanaActionsAllowed(actions, context, intent)` treats the handed `actions` as untrusted evidence. It runs:

1. Hard denials again (defense in depth, same reason): first over the parsed signed message, then over the handed actions (each `programId` and every `ata.create` implied CPI program).
   - **Malformed input rule (v1.1):** the handed list is validated and snapshotted up front, inside one try/catch, before it is used at all.
   - **Handed-actions object form:**
     - The list and every nested array (such as `impliedCpiPrograms`) is a real array: `Array.isArray`, and the prototype is exactly this realm's `Array.prototype`, checked explicitly. Subclasses, null-prototype arrays, arrays re-prototyped to `Object.prototype`, and cross-realm (`vm`) arrays are rejected. It has no holes, and no own keys other than its canonical indices and `length` (symbol keys, `Symbol.iterator` included, are rejected).
     - Every action is a plain object whose prototype is exactly `Object.prototype`, with only own data properties and no symbol keys. Values are primitives, except `impliedCpiPrograms`.
     - Accessors (getters or setters) are rejected without being called.
     - Proxies are rejected outright (`util.types.isProxy`), both for the list and for each action. A Proxy trap is therefore never trusted for descriptors.
     - Arrays are walked with index loops over own property descriptors, never with iteration protocols. No iterator, Proxy trap or getter supplied by the caller ever runs.
   - Any exception while reading the list, or any failed check, becomes `SolanaPolicyDenial` `SOL_DENY_ACTIONS_MISMATCH` with no `instructionIndex`. That includes a throwing Proxy trap, a throwing getter, a sparse array, `{}`, `null` and `42`. A raw `TypeError` never escapes.
   - The policy never falls back to the handed list. Everything after this point works only from the snapshot (for the comparison) and from the policy's own decode.
   - **Malformed handed actions win over decoder errors.** The copy runs before the own decode (1a). For example, `null` actions with a durable-nonce message give `SOL_DENY_ACTIONS_MISMATCH`, not `SOL_DENY_DURABLE_NONCE`.
   - **Deferred to PR4:** an invalid base64 `serializedMessage` makes `parseSolanaMessage` throw a plain `Error` (no `SolanaPolicyDenial` reason). Mapping it to a stable deny reason is deferred to PR4, together with request-level error handling.
1a. Own decode: `decodeSolanaMessage(parseSolanaMessage(intent.tx.serializedMessage))`. Decoder errors keep their own reason and index, for example `SOL_DENY_DURABLE_NONCE` at 2.
1b. `SOL_DENY_ACTIONS_MISMATCH` (no `instructionIndex`): the handed actions must equal the own decode exactly. That means list order (no sorting), JS types (bigint ≠ number ≠ string) and the exact own-property set (an extra key whose value is `undefined` is a mismatch, and so is a missing key).
1c. `SOL_DENY_CLUSTER_MISMATCH` (no `instructionIndex`): `intent.chainId` must equal `context.cluster`.

Steps 2–9 run only on the own decode:

2. `intent.wallet === treasury === message payer`.
3. `programIds` equality (§6.2).
4. Every program is in `config.programs` and is a phase-1 program, else `SOL_DENY_PROGRAM_NOT_ENABLED`. Jupiter (`JUP6…`) as a top-level program never reaches this step: it is `SOL_DENY_PROGRAM_UNKNOWN` at decode in PR3. A `swap` intent is `SOL_DENY_PROGRAM_NOT_ENABLED`. Jupiter arrives in PR5.
5. ComputeBudget values and caps (§4).
6. Treasury-only recipients and authorities (§6.4), over every action in index order:
   - `system.transfer.to`, `transferChecked.destination`, `closeAccount.destination` and `ata.create.wallet`/`payer`;
   - every authority, owner and `from`.

   This runs before shape matching, so a payment to a third party always reports the recipient reason.
7. Action shape for `intent.action` / `intent.venue` (§6.3). Any action not in the shape gives `SOL_DENY_UNEXPECTED_ACTION`. Missing or mismatched values give `SOL_DENY_ACTION_MISMATCH` or `SOL_DENY_AMOUNT_MISMATCH`. `SOL_DENY_ACTION_MISMATCH` has only this step-7 meaning.
8. Mint allowlist, token program and decimals (§6.4). wSOL must have decimals 9 in both the mint registry and the intent, else `SOL_DENY_DECIMALS_MISMATCH` at the first wSOL-touching instruction.
9. Caps (§6.5).

### 6.2 programIds equals the derived set

`intent.programIds` (already sorted and duplicate-free per the PR1 schema) must equal `derivedProgramIds(message, actions)` element by element. The derived set includes each `ata.create`'s implied CPI programs (System and the token program), because the doc commits `programIds` to "all invoked programs, including CPI". PR4 adds the second half: the CPI set from simulation `innerInstructions` must also equal it. Mismatch gives `SOL_DENY_PROGRAM_IDS_MISMATCH`.

### 6.3 Allowed action shapes (no Jupiter)

Every shape also contains exactly one `computeBudget.setComputeUnitLimit` and one `computeBudget.setComputeUnitPrice`.

| intent | Required actions besides ComputeBudget | Rules |
|---|---|---|
| `transfer` / `system` (SOL wrap) | optional `ata.create` for the wSOL ATA, then exactly one `system.transfer`, then exactly one `token.syncNative` | `config.allowWsol === true`; `from === treasury`; `to === treasuryAtas.get(wSOL).ata`; `syncNative.account === to`; `tokenIn.mint === wSOL`, decimals 9; `lamports === amountIn > 0`. `to === from` gives `SOL_DENY_SELF_TRANSFER_NOOP`. |
| `transfer` / `spl-token` (unwrap or close) | exactly one `token.closeAccount` | `account` is a treasury ATA of an allowlisted mint (reverse lookup); `destination === owner === treasury`; mint == `tokenIn.mint`. Non-wSOL: `amountIn === "0"` and PR4 must prove a zero token balance. wSOL (Q4 closed, v1.1): `amountIn` is the exact wSOL ATA token balance. PR3 checks presence and format (canonical u64, else `SOL_DENY_AMOUNT_MISMATCH`), and PR4 proves it equals the balance. |
| `transfer` / `spl-token` (ATA create) | exactly one `ata.create` | §5 rules; `tokenIn.mint === ata.mint`; `amountIn === "0"`. |
| `approve` / `spl-token` | exactly one `token.approveChecked` | `source === treasuryAtas.get(mint).ata`; `owner === treasury`; `delegate ∈ config.delegates` (empty means always deny); `mint === tokenIn.mint`; `decimals === mints[mint].decimals === tokenIn.decimals`; `0 < amount === amountIn < 2⁶⁴−1`. |
| `revoke` / `spl-token` | exactly one `token.revoke` | `source === treasuryAtas.get(tokenIn.mint).ata`; `owner === treasury`; `amountIn === "0"`. Allowed even if the old delegate is no longer allowlisted. |
| `swap` / `jupiter-v6` | – | `SOL_DENY_PROGRAM_NOT_ENABLED` until PR5 (top-level Jupiter instructions are `SOL_DENY_PROGRAM_UNKNOWN` at decode) |

`token.transferChecked` decodes, but there is no allowed top-level shape for it in the no-Jupiter phase. Only derived ATAs are admitted, so a treasury-to-treasury SPL transfer is a no-op and denies with `SOL_DENY_SELF_TRANSFER_NOOP`. Any other destination denies with `SOL_DENY_RECIPIENT_NOT_TREASURY`. The decoder exists for PR5 route accounting and for exact denial reasons.

### 6.4 Mint allowlist and treasury-only recipients

- Allowed mints are `config.mints`. These must be a subset of `SOLANA_PHASE1_MAINNET_MINTS` on mainnet: wSOL `So111…112`, USDC `EPjF…t1v` and USDT `Es9v…NYB`, all classic SPL Token. Devnet uses its own fixture mints and never admits mainnet mints by name (doc §Config).
- Every mint touched by any action must be in `config.mints`, otherwise `SOL_DENY_MINT_NOT_ALLOWED`. Its `tokenProgram` must match the instruction's program, otherwise `SOL_DENY_TOKEN_PROGRAM_MISMATCH`. Decimals must match, otherwise `SOL_DENY_DECIMALS_MISMATCH`.
- Recipients:
  - Every System transfer destination, every token destination, every close destination, and every ATA wallet or payer is the treasury or a derived treasury ATA. Otherwise `SOL_DENY_RECIPIENT_NOT_TREASURY` or `SOL_DENY_ATA_OWNER_NOT_TREASURY`.
  - Every authority, owner or signer is the treasury, otherwise `SOL_DENY_AUTHORITY_NOT_TREASURY`.
  - There is no config recipient list (doc §Transfer action).
- Token-2022 (v1.1): denied as a whole program in phase 1 (`SOL_DENY_PROGRAM_NOT_ENABLED`). Every Token-2022 instruction, and every ATA create whose token program is Token-2022, is denied before any structural check, so no Token-2022 mint can be used even if config lists one. There are no extension checks (no TLV parsing) in PR3, and none is planned for phase 1. `SOL_DENY_TOKEN2022_EXTENSION` stays in the frozen catalog but is reserved and never emitted in PR3.

### 6.5 Caps (raw units in PR3, USD in PR4)

- `debits` is computed per action:
  - `approveChecked.amount` counts against its mint (allowance is spend authority).
  - Wrap `lamports` counts against `native`.
  - `revoke`, `closeAccount` and `ata.create` add 0 principal. Rent goes to `newAccounts` for PR4.
  - wSOL is never double-counted: a wrap is native principal, not a wSOL debit.
- Cap check: `debits[m] ≤ tokenCaps[m]` for every mint touched and for `native`. A missing cap gives `SOL_DENY_CAP_MISSING`; exceeding it gives `SOL_DENY_TOKEN_CAP`.
- `maxPerTxUsd` is checked in PR4 once prices exist. PR3 only asserts it is present (canonical USD decimal, up to 6 decimals, stored as micros).
- `tokenCaps` (each mint and `native`) and `maxPerTxUsd` are required with no default. `assertSolanaClusterReady` already fails without them. PR3 adds tests that an enabled cluster missing any one of them fails readiness, and that `"0"` closes spending.

### 6.6 Phase-1 ceilings (code constants)

```ts
export const SOLANA_PHASE1_CEILINGS = Object.freeze({
  maxComputeUnitLimit: 400000,
  maxComputeUnitPriceMicroLamports: '2500000',
  maxPriorityFeeLamports: '1000000',
  maxRentLamports: '3000000',
  maxFeeUsd: '2.00',
});
```

- There are no defaults. `maxFeeUsd` is required, and the earlier 0.50 default is removed. The policy denies `SOL_DENY_CAP_MISSING` when a compute fee cap is absent.
- Phase 1: config may set any of these values at or below its ceiling, never above (`SOL_DENY_CONFIG_ABOVE_CEILING` at startup). This includes `maxFeeUsd`, which has a 2.00 ceiling.
- The PR2 test `solana-config.test.ts` changed accordingly in PR3 (TDD, #39).

## 7. Deny-reason catalog

```ts
export type SolanaDenyReason =
  | 'SOL_DENY_PROGRAM_UNKNOWN' | 'SOL_DENY_PROGRAM_NOT_ENABLED' | 'SOL_DENY_PROGRAM_HARD_DENIED'
  | 'SOL_DENY_PROGRAM_IDS_MISMATCH'
  | 'SOL_DENY_ACCOUNT_COUNT' | 'SOL_DENY_ACCOUNT_FLAGS' | 'SOL_DENY_DATA_LENGTH' | 'SOL_DENY_NONCANONICAL_DATA'
  | 'SOL_DENY_COMPUTE_BUDGET_INSTRUCTION' | 'SOL_DENY_COMPUTE_BUDGET_CARDINALITY' | 'SOL_DENY_COMPUTE_BUDGET_MISMATCH'
  | 'SOL_DENY_COMPUTE_BUDGET_CAP'
  | 'SOL_DENY_DURABLE_NONCE' | 'SOL_DENY_SYSTEM_INSTRUCTION'
  | 'SOL_DENY_TOKEN_UNCHECKED' | 'SOL_DENY_TOKEN_INSTRUCTION' | 'SOL_DENY_TOKEN_INIT_OUTSIDE_ATA'
  | 'SOL_DENY_TOKEN2022_EXTENSION' | 'SOL_DENY_TOKEN_PROGRAM_MISMATCH'
  | 'SOL_DENY_ATA_INSTRUCTION' | 'SOL_DENY_ATA_DERIVATION' | 'SOL_DENY_ATA_OWNER_NOT_TREASURY'
  | 'SOL_DENY_MINT_NOT_ALLOWED' | 'SOL_DENY_DECIMALS_MISMATCH'
  | 'SOL_DENY_RECIPIENT_NOT_TREASURY' | 'SOL_DENY_AUTHORITY_NOT_TREASURY' | 'SOL_DENY_SELF_TRANSFER_NOOP'
  | 'SOL_DENY_DELEGATE_NOT_ALLOWED' | 'SOL_DENY_APPROVE_AMOUNT' | 'SOL_DENY_WSOL_DISABLED'
  | 'SOL_DENY_UNEXPECTED_ACTION' | 'SOL_DENY_ACTION_MISMATCH' | 'SOL_DENY_AMOUNT_MISMATCH'
  | 'SOL_DENY_CAP_MISSING' | 'SOL_DENY_TOKEN_CAP' | 'SOL_DENY_CONFIG_ABOVE_CEILING'
  | 'SOL_DENY_ACTIONS_MISMATCH' | 'SOL_DENY_CLUSTER_MISMATCH';   // 38 reasons (v1.1)

export class SolanaPolicyDenial extends Error {
  readonly reason: SolanaDenyReason;
  readonly instructionIndex?: number;
  constructor(reason: SolanaDenyReason, detail: string, instructionIndex?: number); // message = `${reason}: ${detail}`
}
```

- Detail strings contain only public data: program ids, indices, mints, amounts. No key material and no RPC URLs.
- The catalog is frozen. New reasons are added only by a spec change.
- `SOL_DENY_CONFIG_ABOVE_CEILING` is a startup error; the rest are request-time errors.
- There are exactly 38 reasons (v1.1).
- `SOL_DENY_ACTIONS_MISMATCH` (v1.1): the handed actions are malformed (§6.1, malformed input rule) or differ from the policy's own decode (§6.1, 1b). It has no `instructionIndex`.
- `SOL_DENY_CLUSTER_MISMATCH` (v1.1): `intent.chainId` differs from `context.cluster` (§6.1, 1c). It has no `instructionIndex`.
- `SOL_DENY_ACTION_MISMATCH` keeps only its step-7 meaning (action shape versus intent).
- `SOL_DENY_TOKEN2022_EXTENSION` is reserved and not emitted in PR3, because Token-2022 is denied as a whole program with `SOL_DENY_PROGRAM_NOT_ENABLED`.
- PR4 adds the fee, rent, blockhash, simulation and USD reasons (§9) in the same union.

## 8. Hard prediction-market denials

```ts
export const SOLANA_HARD_DENIED_PROGRAMS: ReadonlyArray<{ name: string; programId: Base58 | null; status: 'TO VERIFY' | 'verified'; source?: string }> = [
  { name: 'Drift BET (prediction markets)', programId: null, status: 'TO VERIFY' },
  { name: 'Hedgehog Markets', programId: null, status: 'TO VERIFY' },
];
```

- No ID is guessed (doc §Prediction-market ban). An entry with `programId: null` is not enforced and is listed in `solana-pending` as `it.todo`.
- Startup fails if a `verified` entry appears in `config.programs` or `config.innerPrograms` (no override). At request time, a hard-denied top-level program gives `SOL_DENY_PROGRAM_HARD_DENIED`, checked before the allowlist. PR4/PR5 apply the same check to CPI programs.
- If a market shares a program with other products (Drift BET is believed to run inside Drift's main program, TO VERIFY), the doc rule is to deny that whole program in phase 1.
- The closed allowlist already excludes both today.

## 9. Fields PR4 will enforce (defined now, not enforced in PR3)

- **Fee:** `totalFeeLamports = 5000 × 1 + priorityFeeLamports` (from `SolanaDebitSummary`), then the max of that and the `getFeeForMessage` result on both quorum RPCs. Then `ceil(totalFee × solPriceUsdMicros / 1e9) ≤ maxFeeUsd`, with CoinGecko id `solana`, bounds and freshness per the doc. Reasons: `SOL_DENY_FEE_USD_CAP`, `SOL_DENY_FEE_UNAVAILABLE`.
- **Rent:** for each `newAccounts` entry, `getMinimumBalanceForRentExemption(expectedSpace)` on both RPCs. Spaces: 165 for Token. Token-2022 is denied in phase 1, and the `170` value in the type is reserved. The sum must be ≤ `maxRentLamports`, and the simulated lamport debit must match. Reason: `SOL_DENY_RENT_CAP`.
- **USD:** `Σ debits × price ≤ maxPerTxUsd`. Reasons: `SOL_DENY_PER_TX_USD`, `SOL_DENY_PRICE_UNAVAILABLE`.
- **Account state:** existing-ATA mint and owner, zero balance for close, wSOL balance for unwrap (`amountIn` must equal it, per Q4), and delegate state for approve replacement. There are no Token-2022 extension bytes, because Token-2022 is denied.

## 10. Size budget

- Baseline: 994,531 bytes at 1.17.0-rc.8, cap 1,500,000.
- PR3 source is estimated at about 900–1,200 lines. It appears in `dist/index.{js,mjs}` + maps and in the `signer/cli.mjs` bundle; `mcp/cli.mjs` only if imported. **PR3 budget: ≤ +45,000 bytes of gzipped tarball.** CI's tarball-check JSON records the delta and the PR body reports it.
- Whole Solana chain target: ≤ 1,300,000, leaving 200 KB of headroom under the cap.
- `@solana/addresses` stays external (a `dependencies` entry) and adds no bundle bytes. No new dependency in PR3.

## 11. Test-vector plan

### 11.1 Real mainnet messages (read-only, recorded)

- Fetched 1 Nov 2026 via `https://solana-rpc.publicnode.com` with `getSignaturesForAddress` and `getTransaction` (base64, `maxSupportedTransactionVersion: 0`, `finalized`).
- The genesis hash `5eykt4Us…` was confirmed on publicnode and api.mainnet-beta.
- Raw candidates with unsigned message hex are in `/workspace/evalanche-sol-1.18/mainnet-vector-candidates.json`. TDD copies the chosen entries into `test/signer/fixtures/solana-decode/mainnet-messages.json` with signature, slot and fetch time.
- These are public messages from third-party wallets, so most are decoder positives and policy negatives: their recipient is not our treasury. For policy tests, the profile sets `treasury` to the message's own fee payer (a public key, index 0) and derives its ATAs. That way the expected reason is the recipient or ATA rule, not the payer check in step 2.

| Id | Signature | Slot | Shape | Expected |
|---|---|---|---|---|
| R1 | `52pvnYHgfsEVrdq1HX8uY6vnMVFvqEfsHQK9kZArHuCyphsbyBXZUqBT1S8vkZZWu9HXCcQQLGzr2iTdyudBDqwK` | 464121701 | v0: CB price, CB limit, System transfer | decodes; policy `SOL_DENY_RECIPIENT_NOT_TREASURY` |
| R2 | `5Wjvt6FvZLzgqptjrMaT2AvCMkbndkNNdsHhEWQjQP3jmHp7sbrg4bLm4xLXuJ7D5DEPLs3fsxgquc1nnjLWN1gu` | 464121537 | v0: CB, CB, Token transferChecked | decodes; policy `SOL_DENY_RECIPIENT_NOT_TREASURY` |
| R3 | `4TqGpMuipwJCmhaBKvaN9iRd33vKQwHNM28yJTuTfVstzjjUqyqt7kRx33nekK3KBJJD1qGksJH2cw9oLqQDkxJQ` | 464121532 | v0: CB, CB, ATA createIdempotent (USDC), transferChecked, System transfer | ATA derivation matches (bump 255); policy `SOL_DENY_ATA_OWNER_NOT_TREASURY` |
| R4 | `2zfBHaxemmgyrJyaxPaN4YYMQ4euvYJeRbruvRvWYgWEX61ibWEFzC3dios5Tu7izgdVDyidKkFhHWhHxKCp7JuW` | 464121702 | v0: AdvanceNonceAccount first | `SOL_DENY_DURABLE_NONCE` (closes the PR2 open item) |
| R5 | `gHbERoMk316sjExXFGUV2cT4QpzioQ4oUSHK2SmBw87XzaLhXjhtAF3vTqWE3RsN5f7mkjj9cXu1LgiQnsQ1mVP` | 464121702 | v0: System TransferWithSeed ×2 | `SOL_DENY_SYSTEM_INSTRUCTION` |
| R6 | `FCHULYmFEAbLieKijUfr4VacVoT6FF1ZrocA59J2yaomyMLiUm5VbTBPmeKi6PQ65yDuPxhrxhLs948qHvprT3x` | 464121702 | v0: CB limit only, System ×4 | `SOL_DENY_COMPUTE_BUDGET_CARDINALITY` |
| R7 | `4ajCxMeSKszs3aDPNCo8pWdr4v6RhdZttNwyYEtkdS3EtXg9YpPunNHMonUnRDcbVjimwq7BSUWpi267xGbswSRA` | 464121539 | v0: CB limit, price, SetLoadedAccountsDataSizeLimit, unknown program | `SOL_DENY_COMPUTE_BUDGET_INSTRUCTION` |
| R8 | `2TMRp3gse21GAeSYJuZUmYbX6ybdhcfWgD6PxbFzX6k1ChSXJ36WTHaBgZ58EjXWnKnRGCKVDyJuLGvK6kgXo4qG` | 464121482 | v0: CB limit, price, SetLoadedAccountsDataSizeLimit (idx 2), ATA, transfer, syncNative, unknown program | `SOL_DENY_COMPUTE_BUDGET_INSTRUCTION` at idx 2 (order test). Its syncNative and ATA instructions are instruction-level positives |
| R9 | `4QiCHtb7emZXsoncoHUd9g3Kyg2sKYYSs9w8g82sHyFs3YRWgXLyzFBnBTjVaLWxkUEdTs2ZaJiFHWNKKTnt6D8k` | 464121482 | v0: … Token close, Token-2022 close … | the Token-2022 closeAccount at idx 6 denies `SOL_DENY_PROGRAM_NOT_ENABLED` at instruction level; the message denies `SOL_DENY_COMPUTE_BUDGET_INSTRUCTION` at idx 2 |
| R10 | `ceCM7yAbNKVurFU1pMX33XZQFmDuVLp5QTV3CbPZzPtzTtoffo7iFsNCeKxGjHtJsbT8L5WXAQrZiw8QQtRAxnM` | 464121582 | v0: AdvanceNonce, CreateAccountWithSeed, Token-2022 InitializeAccount3 | `SOL_DENY_DURABLE_NONCE` first (order test); the Token-2022 instruction alone denies `SOL_DENY_PROGRAM_NOT_ENABLED` |
| L1 | `5N5JcdiJXJXN8SdVHuodrbdAQCimdNB4qLqM1cgGQDeT7hM4c42qC7NdRojCM5dCnjwoAqPqkLZwkxWrpK8mwzVa` | 464121542 | legacy: unchecked Token Transfer | its instruction bytes re-wrapped into a v0 fixture → `SOL_DENY_TOKEN_UNCHECKED` |
| L2 | `2iKgkPCWDCaDZnRkdUFg5itBJWfhQbUmRbFqw64x2h3a7rksYnqoL3VWPufosUsRmtoEzFBZppLoY54cbLrv64vh` | 464121599 | legacy: temp-account wrap (CreateAccountWithSeed, InitializeAccount3, transfer, syncNative, close) | re-wrapped → `SOL_DENY_SYSTEM_INSTRUCTION` / `SOL_DENY_TOKEN_INIT_OUTSIDE_ATA` |
| L3 | `3JLEkYkb11ZfoYsEDtyW59f7cvW5Ru8Z2hZ4Kn9qsHsBVFwFbAfnnnT2AfUzhA6PvJoBeZuS9ZfzoxHr2prFgJSf` | 464121663 | legacy: Token-2022 Burn, close | re-wrapped → `SOL_DENY_PROGRAM_NOT_ENABLED` at idx 2 |
| L4 | `5nMUBJyAAydorsupWc68Sz2uF5Cv7tHdngGLugb2scCwQg531Pk33ukV6Ff99tJziqf8iRidbGqm5o4uWwer6Z3Z` | 464121582 | legacy, 2 signers: ATA + Token-2022 transferChecked | re-wrapped → `SOL_DENY_PROGRAM_NOT_ENABLED` at idx 2 |
| V1 | `3TD1EQyPKiYnHctRcQim8kaDZRPMTC7WnyiZ8JYrPxXX2wbpTbvhLcS3NpN3Yy5QHbMY5532d4Ys1yVg9cSPE5fE` | 464121664 | v0 with ALTs, includes RequestHeapFrame | `parseSolanaMessage` already denies the ALT; the heap-frame bytes are re-wrapped → `SOL_DENY_COMPUTE_BUDGET_INSTRUCTION` |

- "Re-wrapped" means the recorded instruction bytes are kept exactly and placed in a v0, one-signer message built by `test/signer/solana-message-helpers.ts`. The fixture records the source signature and instruction index.
- Real mainnet `approveChecked` and `revoke` were not found in the 1,450 signatures scanned. TDD either runs a targeted fetch (read-only) or hand-builds them from the layout, marked `provenance: "hand-built"`.

### 11.2 Hand-built positives (fixture treasury public key only, no secret)

These use `key('treasury')` from `solana-message-helpers.ts` and real mint addresses:

- wrap with and without wSOL ATA create;
- unwrap (close wSOL ATA);
- USDC ATA create and createIdempotent;
- zero-balance USDC ATA close;
- exact approveChecked to an allowlisted delegate;
- revoke (also with a delegate no longer listed);
- both ComputeBudget orders;
- caps at the boundary (units = 400,000, price = 2,500,000, priority = 1,000,000).

### 11.3 Hand-built negatives (one mutation each, expected reason pinned)

- **Data:** trailing byte, short data, non-canonical re-encode.
- **Accounts:** an extra account, a missing account, wrong signer flag, wrong writable flag.
- **Recipients and authority:** a recipient that is a valid ATA of another owner, an ATA of the treasury derived with the wrong token program, a close destination that is not the treasury.
- **Approve and transfer amounts:** approve of `u64::MAX`, approve of 0, approve to an unlisted delegate, decimals forged, amount ≠ `amountIn`.
- **Program ids:** a duplicate-free `programIds` that omits the implied System for ATA create, an extra `programIds` entry.
- **Message shape and config:** wrap with `allowWsol: false`, a second System transfer, `syncNative` on a non-treasury account, a Jupiter program present, a hard-denied program (synthetic `verified` entry in a test-only table).
- **ComputeBudget:** caps one unit or one µlamport above, and a priority fee at cap + 1 lamport via rounding.
- **Token-2022:** a Token-2022 instruction and an ATA create using Token-2022, each giving `SOL_DENY_PROGRAM_NOT_ENABLED` (v1.1; no TLV or extension vectors).

### 11.4 Shared vectors for Ops

Shared vectors go in `test/signer/fixtures/solana-decode/policy-vectors.json`. Each entry has `{id, provenance, signature?, slot?, messageHex, intent, configProfile, expected: {actions: DecodedSolanaActionJson[]} | {deny: SolanaDenyReason, instructionIndex?}}`. The signer suite and Ops' `verifier-sol.cjs` must both pass it. Same rule as the existing `solana-approval-vectors.json`.

## 12. JSON form (for vectors and the verifier)

`DecodedSolanaActionJson` is the same as `DecodedSolanaAction` with every `bigint` written as a canonical decimal string and with no other change. It is serialized with the repo's JCS (`src/signer/jcs.ts`), so the signer and verifier can compare byte for byte.

## 13. Open questions (need an answer before or during PR3 review)

1. **The transfer action is nearly empty without Jupiter.** Under treasury-only recipients, SPL `transferChecked` has no legal top-level shape (self-transfer is a no-op). Confirm that "SPL Token transfer path" means decode-and-deny plus wrap, unwrap and ATA housekeeping, not a payment.
2. **Fee caps versus doc. Closed (v1.1).** There are no code defaults: caps are required in the reviewed config, and their absence fails. The code values are hard ceilings. Config may set CU, price, priority fee, rent and `maxFeeUsd` at or below their ceilings, never above (`SOL_DENY_CONFIG_ABOVE_CEILING`). `maxFeeUsd` has a 2.00 ceiling.
3. **Prediction-market program ids.** Drift BET and Hedgehog IDs are TO VERIFY by a named reviewer, with a recorded source.
4. **wSOL unwrap amount. Closed (v1.1).** `amountIn` is the exact wSOL ATA token balance. PR3 checks presence and format (canonical u64), and PR4 proves the balance.
5. **Token-2022 mints. Closed (v1.1).** Token-2022 is denied as a whole program (`SOL_DENY_PROGRAM_NOT_ENABLED`). There is no extension checker in PR3.
6. **Jupiter scope.** Jupiter v6 (PR5) is in scope, with swaps only between allowlisted mints and the treasury as the only recipient. The doc's CPI-only pool-vault exemption (`allowPoolTransfers`, pending Giacomo) is still needed, because Jupiter pays input into AMM vaults. "Treasury as the only recipient" applies to the *output* and to every top-level transfer.

## Amendment log

- v1.0, 2026-11-01: initial spec for TDD (#39) and the implementation (#40).
- v1.1, 2026-11-01, approved by Builder under Giacomo's 2026-10-26 'vai autonomamente' rule for evalanche Solana (tightening only).
  - §6.1: the policy decodes the signed message itself. The new order is hard denials, own decode, `SOL_DENY_ACTIONS_MISMATCH`, `SOL_DENY_CLUSTER_MISMATCH`, then steps 2–9 on the decode only.
  - §6.1: the malformed-input rule (any exception reading the handed actions gives `SOL_DENY_ACTIONS_MISMATCH`, never a fallback) and wSOL decimals 9.
  - §6.6: ceilings with no defaults, as implemented in #40 (`maxFeeUsd` required, 2.00 ceiling).
  - §7: `SOL_DENY_ACTIONS_MISMATCH` and `SOL_DENY_CLUSTER_MISMATCH` added, for 38 reasons. `SOL_DENY_ACTION_MISMATCH` is now step 7 only.
  - The AUTHORITY-before-RECIPIENT ordering minor was reachable only with forged actions, and the actions binding now covers it.
- v1.1 doc corrections (2), 2026-11-01, approved by Builder under the same rule (tightening and consistency only, no new reason):
  - Handed arrays must have exactly this realm's `Array.prototype` (checked explicitly; no iteration, traps or getters).
  - Drift BET and Hedgehog are TO VERIFY, not enforced: their ids are `null`, and only `verified` entries deny.
  - DECODER-INTERFACES step numbering is aligned with §6.1.
- v1.1 doc corrections, 2026-11-01, approved by Builder under the same rule (tightening and consistency only, no new reason):
  - Token-2022 is denied as a whole program (`SOL_DENY_PROGRAM_NOT_ENABLED`), with no extension checks. `token2022.ts`, the TLV vectors and the extension tag row are removed, R9/R10/L3/L4 match the fixtures, and `SOL_DENY_TOKEN2022_EXTENSION` is reserved.
  - Every default is removed (priority fee, and `maxFeeUsd` 0.50). Caps are required, the code values are hard ceilings, and `maxFeeUsd` has a 2.00 ceiling. Q2 is closed.
  - The handed-actions object form is spelled out: plain `Object.prototype` objects, arrays with no extra own keys (symbols included), accessors rejected unread, index loops only.
  - Malformed handed actions win over decoder errors.
  - wSOL Q4 is closed (exact balance; presence and format in PR3, balance in PR4). Q5 is closed.
  - Jupiter is `SOL_DENY_PROGRAM_UNKNOWN` at decode in PR3 and arrives in PR5.
  - Invalid base64 (a plain `Error` from the parser) is deferred to PR4.
