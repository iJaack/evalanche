import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, decode, expectDeny, fromJson, mod, parse, policyContext, requireFn, WSOL } from './helpers';

const vectors: any[] = vectorsJson;
const check = requireFn(mod, 'assertSolanaActionsAllowed');
async function setup(id: string) {
  const v = vectors.find(v => v.id === id);
  const bytes = Buffer.from(v.messageHex, 'hex');
  const intent = structuredClone(v.intent);
  assertIntent(intent);
  const context = await policyContext(parse(bytes).staticAccountKeys[0], v.configProfile);
  return { v, actions: decode(bytes), intent, context };
}
function expectedSummary(v: any) {
  return { ...fromJson(v.expected.debitSummary),
    debits: Object.fromEntries(Object.entries(v.expected.debitSummary.debits).map(([mint, amount]) => [mint, BigInt(amount as string)])) };
}

describe('Solana policy cluster and wSOL decimals', () => {
  // Spec v1.1 §7: the cluster check has its own reason and no instruction index; ACTION_MISMATCH is step 7 only.
  it('intent chainId differing from context cluster denies SOL_DENY_CLUSTER_MISMATCH without instructionIndex', async () => {
    const b = await setup('approve');
    b.context.cluster = b.intent.chainId === 'solana:mainnet' ? 'solana:devnet' : 'solana:mainnet';
    let caught: any;
    expectDeny(() => { try { return check(b.actions, b.context, b.intent); } catch (error) { caught = error; throw error; } },
      'SOL_DENY_CLUSTER_MISMATCH');
    expect(caught.reason).not.toBe('SOL_DENY_ACTION_MISMATCH');
    expect(caught.instructionIndex).toBeUndefined();
  });

  it('matching cluster still allows the approve vector', async () => {
    const b = await setup('approve');
    expect(b.context.cluster).toBe(b.intent.chainId);
    expect(check(b.actions, b.context, b.intent)).toEqual(expectedSummary(b.v));
  });

  it('wSOL registry decimals 8 with intent decimals 8 denies SOL_DENY_DECIMALS_MISMATCH at instruction 2', async () => {
    const b = await setup('wrap');
    b.context.config.mints[WSOL].decimals = 8;
    b.intent.tokenIn.decimals = 8;
    assertIntent(b.intent);
    // The first wSOL-touching action is the system.transfer at instruction 2.
    expectDeny(() => check(b.actions, b.context, b.intent), 'SOL_DENY_DECIMALS_MISMATCH', 2);
  });

  it('wSOL decimals 9 still allows the wrap vector', async () => {
    const b = await setup('wrap');
    expect(b.context.config.mints[WSOL].decimals).toBe(9);
    expect(b.intent.tokenIn.decimals).toBe(9);
    expect(check(b.actions, b.context, b.intent)).toEqual(expectedSummary(b.v));
  });
});
