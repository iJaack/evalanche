/**
 * PR3 spec v1.1 malformed-input rule, regression pins requested by Builder on #40 (5628525).
 * Any malformed handed `actions` must end as SolanaPolicyDenial SOL_DENY_ACTIONS_MISMATCH with no
 * instructionIndex: never a raw TypeError, never a fallback, and accessors are rejected without being called.
 * Builder's decision (v1.1): malformed handed input wins over decoder errors of the signed message.
 */
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
/** expectDeny plus "no instructionIndex", naming what was actually thrown when it fails. */
function deniedNoIndex(fn: () => unknown, reason: string) {
  let caught: any; let outcome = 'allowed';
  try {
    expectDeny(() => { try { return fn(); } catch (error) {
      caught = error;
      outcome = error instanceof Error ? `${error.name}${'reason' in error ? ` ${String((error as any).reason)}` : ''}: ${error.message}` : String(error);
      throw error; } }, reason);
  } catch (error) {
    if (error instanceof Error) error.message = `expected ${reason} but got ${outcome}\n${error.message}`;
    throw error;
  }
  expect(caught.instructionIndex).toBeUndefined();
}

describe('spec v1.1 malformed handed actions: stable SOL_DENY_ACTIONS_MISMATCH', () => {
  it('actions array with an own [Symbol.iterator] = 0 -> ACTIONS_MISMATCH, not a TypeError', async () => {
    const b = await setup('approve');
    const actions: any = [...b.actions];
    actions[Symbol.iterator] = 0;
    deniedNoIndex(() => check(actions, b.context, b.intent), 'SOL_DENY_ACTIONS_MISMATCH');
  });

  it('ata.create impliedCpiPrograms with an own [Symbol.iterator] = 0 -> ACTIONS_MISMATCH, not a TypeError', async () => {
    const b = await setup('usdc-ata-1');
    const ata = b.actions.find(a => a.kind === 'ata.create');
    expect(ata?.impliedCpiPrograms?.length).toBeGreaterThan(0);
    const programs: any = [...ata.impliedCpiPrograms];
    programs[Symbol.iterator] = 0;
    const actions = b.actions.map(a => a === ata ? { ...a, impliedCpiPrograms: programs } : a);
    deniedNoIndex(() => check(actions, b.context, b.intent), 'SOL_DENY_ACTIONS_MISMATCH');
  });

  it('a faithful non-throwing amount getter -> ACTIONS_MISMATCH, and the getter is never invoked', async () => {
    const b = await setup('approve');
    const approve = b.actions.find(a => a.instructionIndex === 2);
    expect(approve.kind).toBe('token.approveChecked');
    let reads = 0;
    const accessor = { ...approve };
    const value = approve.amount;
    Object.defineProperty(accessor, 'amount', { get: () => { reads++; return value; }, enumerable: true, configurable: true });
    const actions = b.actions.map(a => a === approve ? accessor : a);
    // The same list with a data property instead of the accessor is allowed (only the accessor is at fault).
    expect(() => check(b.actions, b.context, b.intent)).not.toThrow();
    deniedNoIndex(() => check(actions, b.context, b.intent), 'SOL_DENY_ACTIONS_MISMATCH');
    expect(reads).toBe(0);
  });

  it('Builder decision: malformed actions (null) win over a durable-nonce decode error -> ACTIONS_MISMATCH, no index', async () => {
    const b = await setup('wrap');
    const ata = b.context.treasuryAtas.get(WSOL).ata;
    const nonce = ix(SYSTEM, u32(4), [meta(key('nonce-account'), true), meta(key('recent-blockhashes')), meta(b.context.treasury, false, true)]);
    const transfer = ix(SYSTEM, systemData('100'), [meta(b.context.treasury, true, true), meta(ata, true)]);
    const sync = ix(TOKEN, Buffer.from([17]), [meta(ata, true)]);
    const bytes = rewrap(...budget(), nonce, transfer, sync);
    const intent = boundIntent(bytes, { action: 'transfer', venue: 'system', tokenIn: { mint: WSOL, symbol: 'wSOL', decimals: 9 }, amountIn: '100' });
    // The message itself is a durable-nonce decode error at instruction 2.
    expectDeny(() => decodeMessage(bytes), 'SOL_DENY_DURABLE_NONCE', 2);
    deniedNoIndex(() => check(null as any, b.context, intent), 'SOL_DENY_ACTIONS_MISMATCH');
  });
});
