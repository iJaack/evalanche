/**
 * PR3 spec v1.1 (Builder-approved amendment):
 *   §6 order: 1 hard denials -> own decode of the signed message (decoder errors keep their reason)
 *             -> SOL_DENY_ACTIONS_MISMATCH -> SOL_DENY_CLUSTER_MISMATCH (no instructionIndex) -> steps 2–9 on the decode.
 *   §6: any exception while comparing the supplied actions becomes SOL_DENY_ACTIONS_MISMATCH, never a fallback.
 *   §7: 38 reasons; ACTION_MISMATCH keeps only its step-7 meaning.
 * Conservative TDD choice: malformed supplied actions that the step-1 loop over supplied actions touches
 * before the comparison (non-iterable, sparse, throwing iteration or programId) must still end as a stable
 * SolanaPolicyDenial with SOL_DENY_ACTIONS_MISMATCH, never a raw TypeError/Error.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, boundIntent, budget, expectDeny, ix, key, meta, mod, parse, policyContext, requireFn,
  rewrap, SYSTEM, systemData, TOKEN, u32, WSOL } from './helpers';

const vectors: any[] = vectorsJson;
const check = requireFn(mod, 'assertSolanaActionsAllowed');
const decodeMessage = (bytes: Uint8Array) => requireFn(mod, 'decodeSolanaMessage')(parse(bytes));
async function setup(id: string) {
  const v = vectors.find(v => v.id === id);
  const bytes = Buffer.from(v.messageHex, 'hex');
  const intent = structuredClone(v.intent);
  assertIntent(intent);
  const context = await policyContext(parse(bytes).staticAccountKeys[0], v.configProfile);
  return { v, bytes, actions: decodeMessage(bytes) as any[], intent, context };
}
const otherCluster = (chainId: string) => chainId === 'solana:mainnet' ? 'solana:devnet' : 'solana:mainnet';
/** expectDeny plus an explicit message naming what was actually thrown (or that the call was allowed). */
function denied(fn: () => unknown, reason: string, instructionIndex?: number | 'none') {
  let caught: any; let outcome = 'allowed';
  try {
    expectDeny(() => { try { return fn(); } catch (error) {
      caught = error; outcome = error instanceof Error ? `${error.name}${'reason' in error ? ` ${String((error as any).reason)}` : ''}: ${error.message}` : String(error);
      throw error; } }, reason, instructionIndex === 'none' ? undefined : instructionIndex);
  } catch (error) {
    if (error instanceof Error) error.message = `expected ${reason} but got ${outcome}\n${error.message}`;
    throw error;
  }
  if (instructionIndex === 'none') expect(caught.instructionIndex).toBeUndefined();
}

describe('spec v1.1 §6 order around SOL_DENY_CLUSTER_MISMATCH', () => {
  it('cluster mismatch beats payer/wallet (2): CLUSTER_MISMATCH, not AUTHORITY_NOT_TREASURY', async () => {
    const b = await setup('approve');
    b.context.treasury = key('other-owner'); b.intent.wallet = key('other-owner'); assertIntent(b.intent);
    // The step-2 fault is real on its own.
    denied(() => check(b.actions, b.context, b.intent), 'SOL_DENY_AUTHORITY_NOT_TREASURY', 'none');
    b.context.cluster = otherCluster(b.intent.chainId);
    denied(() => check(b.actions, b.context, b.intent), 'SOL_DENY_CLUSTER_MISMATCH', 'none');
  });
  it('actions mismatch beats cluster mismatch', async () => {
    const b = await setup('approve');
    b.context.cluster = otherCluster(b.intent.chainId);
    const approve = b.actions.find(a => a.instructionIndex === 2);
    expect(approve.kind).toBe('token.approveChecked');
    approve.amount += 1n;
    denied(() => check(b.actions, b.context, b.intent), 'SOL_DENY_ACTIONS_MISMATCH', 'none');
  });
  it('a decoder error of the signed message (durable nonce @2) beats cluster mismatch', async () => {
    const b = await setup('wrap');
    const ata = b.context.treasuryAtas.get(WSOL).ata;
    const nonce = ix(SYSTEM, u32(4), [meta(key('nonce-account'), true), meta(key('recent-blockhashes')), meta(b.context.treasury, false, true)]);
    const transfer = ix(SYSTEM, systemData('100'), [meta(b.context.treasury, true, true), meta(ata, true)]);
    const sync = ix(TOKEN, Buffer.from([17]), [meta(ata, true)]);
    const bytes = rewrap(...budget(), nonce, transfer, sync);
    const intent = boundIntent(bytes, { action: 'transfer', venue: 'system', tokenIn: { mint: WSOL, symbol: 'wSOL', decimals: 9 }, amountIn: '100' });
    b.context.cluster = otherCluster(intent.chainId);
    denied(() => check(b.actions, b.context, intent), 'SOL_DENY_DURABLE_NONCE', 2);
  });
});

describe('spec v1.1 §6: exceptions while reading supplied actions become SOL_DENY_ACTIONS_MISMATCH', () => {
  const boom = () => { throw new Error('boom'); };
  const cases: Array<[string, (actions: any[]) => unknown]> = [
    // Reached only by the comparison (for-of iteration does not call ownKeys).
    ['array Proxy whose ownKeys trap throws', actions => new Proxy(actions, { ownKeys: boom })],
    // Reached only by the comparison: the step-1 loop reads programId/kind, never amount.
    ['action with a throwing amount getter', actions => actions.map(a => a.instructionIndex === 2
      ? Object.defineProperty({ ...a }, 'amount', { get: boom, enumerable: true }) : a)],
    // The following are touched by the step-1 loop over supplied actions first (conservative expectation).
    ['array Proxy whose get trap throws', actions => new Proxy(actions, { get: boom })],
    ['action with a throwing programId getter', actions => actions.map(a => a.instructionIndex === 2
      ? Object.defineProperty({ ...a }, 'programId', { get: boom, enumerable: true }) : a)],
    ['sparse array (hole at index 1)', actions => { const s = [...actions]; delete s[1]; return s; }],
    ['non-iterable plain object', () => ({})],
    ['null', () => null],
    ['number', () => 42],
  ];
  for (const [name, make] of cases) {
    it(`${name} -> SolanaPolicyDenial SOL_DENY_ACTIONS_MISMATCH`, async () => {
      const b = await setup('approve');
      denied(() => check(make(b.actions), b.context, b.intent), 'SOL_DENY_ACTIONS_MISMATCH', 'none');
    });
  }
});

describe('spec v1.1 §7 deny-reason catalog', () => {
  // SolanaDenyReason is type-only (no runtime export), so the union is read from source.
  const V11 = [
    'SOL_DENY_PROGRAM_UNKNOWN', 'SOL_DENY_PROGRAM_NOT_ENABLED', 'SOL_DENY_PROGRAM_HARD_DENIED', 'SOL_DENY_PROGRAM_IDS_MISMATCH',
    'SOL_DENY_ACCOUNT_COUNT', 'SOL_DENY_ACCOUNT_FLAGS', 'SOL_DENY_DATA_LENGTH', 'SOL_DENY_NONCANONICAL_DATA',
    'SOL_DENY_COMPUTE_BUDGET_INSTRUCTION', 'SOL_DENY_COMPUTE_BUDGET_CARDINALITY', 'SOL_DENY_COMPUTE_BUDGET_MISMATCH',
    'SOL_DENY_COMPUTE_BUDGET_CAP', 'SOL_DENY_DURABLE_NONCE', 'SOL_DENY_SYSTEM_INSTRUCTION',
    'SOL_DENY_TOKEN_UNCHECKED', 'SOL_DENY_TOKEN_INSTRUCTION', 'SOL_DENY_TOKEN_INIT_OUTSIDE_ATA',
    'SOL_DENY_TOKEN2022_EXTENSION', 'SOL_DENY_TOKEN_PROGRAM_MISMATCH',
    'SOL_DENY_ATA_INSTRUCTION', 'SOL_DENY_ATA_DERIVATION', 'SOL_DENY_ATA_OWNER_NOT_TREASURY',
    'SOL_DENY_MINT_NOT_ALLOWED', 'SOL_DENY_DECIMALS_MISMATCH',
    'SOL_DENY_RECIPIENT_NOT_TREASURY', 'SOL_DENY_AUTHORITY_NOT_TREASURY', 'SOL_DENY_SELF_TRANSFER_NOOP',
    'SOL_DENY_DELEGATE_NOT_ALLOWED', 'SOL_DENY_APPROVE_AMOUNT', 'SOL_DENY_WSOL_DISABLED',
    'SOL_DENY_UNEXPECTED_ACTION', 'SOL_DENY_ACTION_MISMATCH', 'SOL_DENY_AMOUNT_MISMATCH',
    'SOL_DENY_CAP_MISSING', 'SOL_DENY_TOKEN_CAP', 'SOL_DENY_CONFIG_ABOVE_CEILING',
    'SOL_DENY_ACTIONS_MISMATCH', 'SOL_DENY_CLUSTER_MISMATCH',
  ];
  it('SolanaDenyReason has exactly the 38 v1.1 reasons, including ACTIONS_MISMATCH and CLUSTER_MISMATCH', () => {
    const source = readFileSync(new URL('../../../src/signer/solana-decode/errors.ts', import.meta.url), 'utf8');
    const union = /export type SolanaDenyReason\s*=([^;]*);/.exec(source)?.[1] ?? '';
    const reasons = [...union.matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]);
    expect(V11).toHaveLength(38);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect([...reasons].sort()).toEqual([...V11].sort());
  });
});
