import { isProxy } from 'node:util/types';
import { parseSolanaMessage, solanaPriorityFeeLamports, type SolanaChainId, type SolanaSigningIntent } from '../solana-intent';
import type { ResolvedSolanaCluster } from '../solana-policy';
import { type TreasuryAtaMap, treasuryAtaOwnerOf } from './ata';
import { ATA, COMPUTE, SYSTEM, TOKEN, WSOL, SOLANA_PHASE1_CEILINGS } from './constants';
import { assertComputeBudgetCardinality, assertProgramNotHardDenied, decodeSolanaMessage, derivedProgramIds } from './decode';
import { deny, type SolanaDenyReason } from './errors';
import type { Base58, DecodedSolanaAction, TokenProgramId } from './types';
export interface SolanaPolicyContext {
  cluster: SolanaChainId; config: ResolvedSolanaCluster; treasury: Base58; treasuryAtas: TreasuryAtaMap;
}
export interface SolanaDebitSummary {
  debits: Readonly<Record<Base58 | 'native', bigint>>;
  newAccounts: ReadonlyArray<{ address: Base58; tokenProgram: TokenProgramId; expectedSpace: 165 | 170 }>;
  priorityFeeLamports: bigint;
}
const U64_MAX = 0xffffffffffffffffn;
function rawAmount(value: unknown, index?: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20 || BigInt(value) > U64_MAX) {
    deny('SOL_DENY_AMOUNT_MISMATCH', 'amountIn must be a canonical u64', index);
  }
  return BigInt(value);
}
/** Compare every own key and value without coercion, preserving array order. */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  const leftRecord = left as Record<PropertyKey, unknown>;
  const rightRecord = right as Record<PropertyKey, unknown>;
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.hasOwn(right, key) && structurallyEqual(leftRecord[key], rightRecord[key]));
}
/** Copy string-keyed data properties without invoking accessors. */
function snapshotProperties(source: object, target: object, normalize: (value: unknown, key: string) => unknown): void {
  const keys = Reflect.ownKeys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string') throw new Error('action keys must be strings');
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('actions must contain only data properties');
    Object.defineProperty(target, key, { value: normalize(descriptor.value, key),
      enumerable: descriptor.enumerable, writable: true, configurable: true });
  }
}
function snapshotPrimitive(value: unknown): unknown {
  if ((value !== null && typeof value === 'object') || typeof value === 'function') {
    throw new Error('action values must be primitive');
  }
  return value;
}
function snapshotArray<T>(value: unknown, element: (value: unknown) => T): T[] {
  if (isProxy(value) || !Array.isArray(value)) throw new Error('actions must use real arrays');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw new Error('invalid action array length');
  }
  const keys = Reflect.ownKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
      throw new Error('action arrays must contain only index keys and length');
    }
  }
  if (keys.length !== length + 1) throw new Error('action arrays must not have holes');
  const result: T[] = [];
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item || !('value' in item)) throw new Error('action arrays must contain only own data elements');
    result.push(element(item.value));
  }
  return result;
}
function snapshotAction(value: unknown): Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('actions must be plain objects');
  }
  const result: Record<PropertyKey, unknown> = {};
  snapshotProperties(value, result, (item, key) => key === 'impliedCpiPrograms'
    ? snapshotArray(item, snapshotPrimitive) : snapshotPrimitive(item));
  return result;
}
/** Pure offline policy; USD valuation, rent and account balances require PR4 evidence. */
export function assertSolanaActionsAllowed(
  actions: readonly DecodedSolanaAction[], context: SolanaPolicyContext, intent: SolanaSigningIntent,
): SolanaDebitSummary {
  const { config: c, treasury, treasuryAtas: atas } = context;
  // 1. Hard denials, including the actual message even for supplied decoded evidence.
  const message = parseSolanaMessage(intent.tx.serializedMessage);
  for (const [index, ix] of message.instructions.entries()) assertProgramNotHardDenied(ix.programId, index);
  let snapshot: Record<PropertyKey, unknown>[];
  try {
    snapshot = snapshotArray(actions, snapshotAction);
  } catch {
    deny('SOL_DENY_ACTIONS_MISMATCH', 'supplied actions are not plain data');
  }
  for (let i = 0; i < snapshot.length; i++) {
    const a = snapshot[i];
    const index = typeof a.instructionIndex === 'number' ? a.instructionIndex : undefined;
    if (typeof a.programId === 'string') assertProgramNotHardDenied(a.programId, index);
    if (a.kind === 'ata.create' && Array.isArray(a.impliedCpiPrograms)) {
      for (let j = 0; j < a.impliedCpiPrograms.length; j++) {
        const p: unknown = a.impliedCpiPrograms[j];
        if (typeof p === 'string') assertProgramNotHardDenied(p, index);
      }
    }
  }
  // Bind supplied evidence and cluster before steps 2–9.
  const decoded = decodeSolanaMessage(message);
  if (!structurallyEqual(snapshot, decoded)) {
    deny('SOL_DENY_ACTIONS_MISMATCH', 'supplied actions differ from the signed message');
  }
  if (intent.chainId !== context.cluster) {
    deny('SOL_DENY_CLUSTER_MISMATCH', 'intent cluster differs from policy context');
  }
  // 2–4. Bind payer, program commitment and explicit phase admission.
  if (intent.wallet !== treasury || message.staticAccountKeys[0] !== treasury) {
    deny('SOL_DENY_AUTHORITY_NOT_TREASURY', 'wallet and payer must be treasury');
  }
  const programs = derivedProgramIds(message, decoded);
  if (programs.length !== intent.programIds.length || programs.some((p, i) => p !== intent.programIds[i])) {
    deny('SOL_DENY_PROGRAM_IDS_MISMATCH', 'program commitment differs from derived programs');
  }
  // Admission covers the whole operation; attribute a missing dependency to its start.
  const operationIndex = decoded.find(a => !a.kind.startsWith('computeBudget.'))?.instructionIndex;
  const enabled = (p: string, index = operationIndex) => {
    if (![SYSTEM, TOKEN, ATA, COMPUTE].includes(p) || !c.programs?.includes(p)) {
      deny('SOL_DENY_PROGRAM_NOT_ENABLED', `program ${p} is not enabled`, index);
    }
  };
  for (const a of decoded) {
    enabled(a.programId);
    if (a.kind === 'ata.create') for (const p of a.impliedCpiPrograms) enabled(p);
  }
  for (const p of programs) enabled(p);
  if (intent.action === 'swap') deny('SOL_DENY_PROGRAM_NOT_ENABLED', 'Jupiter swaps are disabled');
  // 5. Exactly one of each budget instruction, matching the intent and explicit caps.
  assertComputeBudgetCardinality(decoded);
  const limit = decoded.find((a): a is Extract<DecodedSolanaAction, {kind: 'computeBudget.setComputeUnitLimit'}> => a.kind === 'computeBudget.setComputeUnitLimit')!;
  const price = decoded.find((a): a is Extract<DecodedSolanaAction, {kind: 'computeBudget.setComputeUnitPrice'}> => a.kind === 'computeBudget.setComputeUnitPrice')!;
  if (limit.units < 1 || limit.units !== intent.tx.computeUnitLimit || price.microLamports.toString() !== intent.tx.computeUnitPriceMicroLamports) {
    deny('SOL_DENY_COMPUTE_BUDGET_MISMATCH', 'compute budget differs from intent');
  }
  const fees = c.fees;
  if (fees.maxComputeUnitLimit === undefined || fees.maxComputeUnitPriceMicroLamports === undefined || fees.maxPriorityFeeLamports === undefined) {
    deny('SOL_DENY_CAP_MISSING', 'explicit compute fee caps required');
  }
  const priorityFeeLamports = solanaPriorityFeeLamports(limit.units, price.microLamports);
  if (limit.units > Math.min(fees.maxComputeUnitLimit, SOLANA_PHASE1_CEILINGS.maxComputeUnitLimit)
    || price.microLamports > BigInt(fees.maxComputeUnitPriceMicroLamports)
    || price.microLamports > BigInt(SOLANA_PHASE1_CEILINGS.maxComputeUnitPriceMicroLamports)
    || priorityFeeLamports > BigInt(fees.maxPriorityFeeLamports)
    || priorityFeeLamports > BigInt(SOLANA_PHASE1_CEILINGS.maxPriorityFeeLamports)) {
    deny('SOL_DENY_COMPUTE_BUDGET_CAP', 'compute budget exceeds fee caps');
  }
  const ownAta = (address: string) => treasuryAtaOwnerOf(atas, address) !== undefined;
  const requireParty = (ok: boolean, reason: SolanaDenyReason, a: DecodedSolanaAction) => {
    if (!ok) deny(reason, `invalid party for ${a.kind}`, a.instructionIndex);
  };
  const authority = (address: string, a: DecodedSolanaAction) => requireParty(address === treasury, 'SOL_DENY_AUTHORITY_NOT_TREASURY', a);
  const recipient = (ok: boolean, a: DecodedSolanaAction) => requireParty(ok, 'SOL_DENY_RECIPIENT_NOT_TREASURY', a);
  // 6. Per-action party checks in instruction order, before matching any action shape.
  for (const a of decoded) {
    switch (a.kind) {
      case 'system.transfer': authority(a.from, a); recipient(a.to === treasury || ownAta(a.to), a); break;
      case 'token.transferChecked':
        authority(a.authority, a); recipient(ownAta(a.destination), a);
        requireParty(ownAta(a.source), 'SOL_DENY_AUTHORITY_NOT_TREASURY', a); break;
      case 'token.approveChecked': authority(a.owner, a); break;
      case 'token.revoke': authority(a.owner, a); break;
      case 'token.closeAccount': authority(a.owner, a); recipient(a.destination === treasury, a); break;
      case 'ata.create': requireParty(a.payer === treasury && a.wallet === treasury, 'SOL_DENY_ATA_OWNER_NOT_TREASURY', a); break;
    }
  }
  // 7. Closed action shapes. Unexpected extras report their own instruction index.
  const business = decoded.filter(a => !a.kind.startsWith('computeBudget.'));
  const mismatch = (a?: DecodedSolanaAction): never => deny('SOL_DENY_ACTION_MISMATCH', 'actions differ from intent', a?.instructionIndex);
  const amountMismatch = (a: DecodedSolanaAction): never => deny('SOL_DENY_AMOUNT_MISMATCH', 'amount differs from intent', a.instructionIndex);
  for (const a of business) {
    if ((a.kind === 'system.transfer' && a.from === a.to) || a.kind === 'token.transferChecked') {
      deny('SOL_DENY_SELF_TRANSFER_NOOP', 'treasury self transfer is a no-op', a.instructionIndex);
    }
  }
  let expected: DecodedSolanaAction['kind'][];
  const first = business[0];
  if (intent.action === 'transfer' && intent.venue === 'system') {
    if (!c.allowWsol) deny('SOL_DENY_WSOL_DISABLED', 'wSOL wrap is disabled');
    expected = [...(first?.kind === 'ata.create' ? ['ata.create' as const] : []), 'system.transfer', 'token.syncNative'];
  } else if (intent.action === 'approve') expected = ['token.approveChecked'];
  else if (intent.action === 'revoke') expected = ['token.revoke'];
  else if (intent.action === 'transfer' && intent.venue === 'spl-token') {
    expected = [first?.kind === 'ata.create' ? 'ata.create' : 'token.closeAccount'];
  } else return mismatch(first);
  for (let i = 0; i < business.length; i++) {
    if (business[i].kind !== expected[i]) deny('SOL_DENY_UNEXPECTED_ACTION', `unexpected ${business[i].kind}`, business[i].instructionIndex);
  }
  if (business.length !== expected.length) mismatch(first);
  for (const a of business) {
    const amount = rawAmount(intent.amountIn, a.instructionIndex);
    switch (a.kind) {
      case 'system.transfer':
        if (intent.tokenIn.mint !== WSOL || a.to !== atas.get(WSOL)?.ata) mismatch(a);
        if (a.lamports === 0n || a.lamports !== amount) amountMismatch(a);
        break;
      case 'token.syncNative': if (a.account !== atas.get(WSOL)?.ata) mismatch(a); break;
      case 'ata.create':
        if (a.mint !== intent.tokenIn.mint || (intent.venue === 'system' && a.mint !== WSOL)) mismatch(a);
        if (intent.venue !== 'system' && amount !== 0n) amountMismatch(a);
        break;
      case 'token.closeAccount': {
        const mint = treasuryAtaOwnerOf(atas, a.account);
        if (!mint || mint !== intent.tokenIn.mint) mismatch(a);
        if (mint !== WSOL && amount !== 0n) amountMismatch(a);
        break;
      }
      case 'token.approveChecked':
        if (a.mint !== intent.tokenIn.mint) mismatch(a);
        if (!c.delegates?.includes(a.delegate)) deny('SOL_DENY_DELEGATE_NOT_ALLOWED', 'delegate is not admitted', a.instructionIndex);
        if (a.amount <= 0n || a.amount >= U64_MAX) deny('SOL_DENY_APPROVE_AMOUNT', 'approve amount must be positive and below u64 max', a.instructionIndex);
        if (a.amount !== amount) amountMismatch(a);
        break;
      case 'token.revoke':
        if (a.source !== atas.get(intent.tokenIn.mint)?.ata) mismatch(a);
        if (amount !== 0n) amountMismatch(a);
        break;
    }
  }
  // 8. Mint metadata and derived source/ATA binding.
  const touched = new Set<string>();
  for (const a of business) {
    const mint = 'mint' in a ? a.mint : a.kind === 'system.transfer' || a.kind === 'token.syncNative' ? WSOL : intent.tokenIn.mint;
    const metadata = Object.hasOwn(c.mints ?? {}, mint) ? c.mints![mint] : undefined;
    if (!metadata) deny('SOL_DENY_MINT_NOT_ALLOWED', `mint ${mint} is not admitted`, a.instructionIndex);
    touched.add(mint);
    const tokenProgram = 'tokenProgram' in a ? a.tokenProgram : TOKEN;
    if (tokenProgram !== metadata.tokenProgram) deny('SOL_DENY_TOKEN_PROGRAM_MISMATCH', 'token program differs from mint registry', a.instructionIndex);
    if ((mint === WSOL && (metadata.decimals !== 9 || intent.tokenIn.decimals !== 9))
      || metadata.decimals !== intent.tokenIn.decimals || ('decimals' in a && a.decimals !== metadata.decimals)) {
      deny('SOL_DENY_DECIMALS_MISMATCH', 'decimals differ from mint registry', a.instructionIndex);
    }
    const account = a.kind === 'ata.create' ? a.ata : a.kind === 'token.approveChecked' || a.kind === 'token.revoke' ? a.source : undefined;
    if (account !== undefined && (account !== atas.get(mint)?.ata || tokenProgram !== atas.get(mint)?.tokenProgram)) {
      deny('SOL_DENY_ATA_DERIVATION', 'account differs from treasury ATA', a.instructionIndex);
    }
  }
  // 9. Gross principal/allowance, never net credits or duplicate wSOL principal.
  const debits: Record<string, bigint> = {};
  const newAccounts: Array<{address: Base58; tokenProgram: TokenProgramId; expectedSpace: 165 | 170}> = [];
  for (const a of business) {
    if (a.kind === 'system.transfer') { debits.native = (debits.native ?? 0n) + a.lamports; touched.add('native'); }
    if (a.kind === 'token.approveChecked') debits[a.mint] = (debits[a.mint] ?? 0n) + a.amount;
    if (a.kind === 'ata.create') newAccounts.push({address: a.ata, tokenProgram: a.tokenProgram, expectedSpace: 165});
  }
  if (typeof c.maxPerTxUsd !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(c.maxPerTxUsd)) {
    deny('SOL_DENY_CAP_MISSING', 'explicit canonical maxPerTxUsd required');
  }
  for (const mint of touched) {
    const cap = c.tokenCaps?.[mint];
    if (cap === undefined || !/^(0|[1-9][0-9]*)$/.test(cap)) deny('SOL_DENY_CAP_MISSING', `missing cap for ${mint}`);
    if ((debits[mint] ?? 0n) > BigInt(cap)) deny('SOL_DENY_TOKEN_CAP', `debit exceeds cap for ${mint}`);
  }
  return { debits, newAccounts, priorityFeeLamports };
}
