/**
 * Conservative TDD order: after step 1 (hard denials), bind the supplied actions
 * exactly to decodeSolanaMessage(parseSolanaMessage(intent.tx.serializedMessage)),
 * BEFORE payer/wallet (2) and every policy fault in steps 3–9. Decoder errors
 * precede comparison. Equality preserves list order, JS types (including bigint),
 * and every property: no missing or extra fields. Never sort before comparing.
 */
import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, boundIntent, budget, checkedData, decode, expectDeny, fromJson, ix, key, meta, mod,
  parse, policyContext, requireFn, rewrap, SYSTEM, systemData, TOKEN, toJson, u32, USDC, USDT, WSOL } from './helpers';

const vectors: any[] = vectorsJson;
const MISMATCH = 'SOL_DENY_ACTIONS_MISMATCH';
async function setup(id: string) {
  const v = vectors.find(v => v.id === id);
  const bytes = Buffer.from(v.messageHex, 'hex');
  const intent = structuredClone(v.intent);
  assertIntent(intent);
  const context = await policyContext(parse(bytes).staticAccountKeys[0], v.configProfile);
  return { v, bytes, actions: decode(bytes), intent, context };
}
type Baseline = Awaited<ReturnType<typeof setup>>;
const check = requireFn(mod, 'assertSolanaActionsAllowed');
function action(b: Baseline, instructionIndex: number, kind: string): any {
  const found = b.actions.find((a: any) => a.instructionIndex === instructionIndex);
  expect(found?.kind).toBe(kind);
  return found;
}
/** Keep expectDeny's exact checks and make allowed/wrong-reason red results explicit. */
function expectPolicyDeny(b: Baseline, reason = MISMATCH, instructionIndex?: number) {
  assertIntent(b.intent);
  let outcome = 'allowed';
  try {
    expectDeny(() => {
      try { return check(b.actions, b.context, b.intent); }
      catch (error) {
        outcome = error instanceof Error && 'reason' in error ? String(error.reason) : String(error);
        throw error;
      }
    }, reason, instructionIndex);
  } catch (error) {
    if (error instanceof Error) error.message = `expected '${reason}' but got ${outcome}\n${error.message}`;
    throw error;
  }
}

describe('actions are bound exactly to the signed Solana message', () => {
  for (const id of ['policy-R1', 'policy-R2', 'policy-R3']) {
    it(`${id}: matching actions preserve the fixture denial`, async () => {
      const b = await setup(id);
      expectPolicyDeny(b, b.v.expected.deny, b.v.expected.instructionIndex);
    });
  }
  for (const id of ['approve', 'wrap', 'usdc-ata-1', 'unwrap-0']) {
    it(`${id}: matching actions preserve the exact debitSummary`, async () => {
      const b = await setup(id);
      expect(b.actions).toEqual(fromJson(b.v.expected.actions));
      expect(toJson(b.actions)).toEqual(b.v.expected.actions);
      const summary = check(b.actions, b.context, b.intent);
      const expected = { ...fromJson(b.v.expected.debitSummary),
        debits: Object.fromEntries(Object.entries(b.v.expected.debitSummary.debits).map(([k, n]) => [k, BigInt(n as string)])) };
      expect(summary).toEqual(expected);
      expect(toJson(summary)).toEqual(b.v.expected.debitSummary);
      expect(typeof summary.priorityFeeLamports).toBe('bigint');
    });
  }

  const fieldCases: Array<[string, string, (b: Baseline) => void]> = [
    ['R3 transferChecked amount +1n', 'policy-R3', b => { action(b, 3, 'token.transferChecked').amount += 1n; }],
    ['R3 transferChecked destination replaced', 'policy-R3', b => { action(b, 3, 'token.transferChecked').destination = key('third-key'); }],
    ['R3 transferChecked mint replaced with USDT', 'policy-R3', b => { action(b, 3, 'token.transferChecked').mint = USDT; }],
    ['R3 transferChecked authority replaced', 'policy-R3', b => { action(b, 3, 'token.transferChecked').authority = key('other-owner'); }],
    ['R3 ATA wallet replaced with payer', 'policy-R3', b => { action(b, 2, 'ata.create').wallet = b.context.treasury; }],
    ['R1 transfer recipient replaced with payer wSOL ATA', 'policy-R1', b => {
      action(b, 2, 'system.transfer').to = b.context.treasuryAtas.get(WSOL).ata;
    }],
    ['R1 transfer lamports +1n', 'policy-R1', b => { action(b, 2, 'system.transfer').lamports += 1n; }],
    ['R2 token programId replaced', 'policy-R2', b => { action(b, 2, 'token.transferChecked').programId = key('different-program'); }],
    ['R1 instructionIndex changed', 'policy-R1', b => { action(b, 2, 'system.transfer').instructionIndex = 3; }],
    ['R3 bigint amount replaced with equal number 385253', 'policy-R3', b => {
      const a = action(b, 3, 'token.transferChecked'); expect(a.amount).toBe(385253n); a.amount = 385253;
    }],
    ['R3 bigint amount replaced with equal string 385253', 'policy-R3', b => {
      const a = action(b, 3, 'token.transferChecked'); expect(a.amount).toBe(385253n); a.amount = '385253';
    }],
    ['R3 amount property missing', 'policy-R3', b => { delete action(b, 3, 'token.transferChecked').amount; }],
  ];
  for (const [name, id, tamper] of fieldCases) {
    it(`${name} denies actions mismatch`, async () => {
      const b = await setup(id); tamper(b); expectPolicyDeny(b);
    });
  }

  const listCases: Array<[string, (b: Baseline) => void]> = [
    ['missing action at index 4', b => { action(b, 4, 'system.transfer'); b.actions = b.actions.filter((a: any) => a.instructionIndex !== 4); }],
    ['duplicate action at index 4 appended', b => { b.actions.push(structuredClone(action(b, 4, 'system.transfer'))); }],
    ['extra benign computeBudget action', b => {
      b.actions.push({ ...b.actions[0], instructionIndex: 5 });
    }],
    ['indices 3 and 4 swapped', b => { [b.actions[3], b.actions[4]] = [b.actions[4], b.actions[3]]; }],
    ['whole list reversed', b => { b.actions.reverse(); }],
    ['extra unknown property', b => { action(b, 3, 'token.transferChecked').untrustedExtra = true; }],
    ['extra unknown undefined property', b => { action(b, 3, 'token.transferChecked').untrustedExtra = undefined; }],
  ];
  for (const [name, tamper] of listCases) {
    it(`R3 ${name} denies actions mismatch`, async () => {
      const b = await setup('policy-R3'); tamper(b); expectPolicyDeny(b);
    });
  }

  it('close-wrong-destination cannot substitute the actions of unwrap-0', async () => {
    const b = await setup('close-wrong-destination');
    expectPolicyDeny(b, 'SOL_DENY_RECIPIENT_NOT_TREASURY', 2);
    b.actions = (await setup('unwrap-0')).actions;
    expectPolicyDeny(b);
  });
  it('approve amount 100000001 on the wire cannot substitute the original approve actions', async () => {
    const b = await setup('approve');
    const approve = ix(TOKEN, checkedData(13, '100000001'), [meta(b.context.treasuryAtas.get(USDC).ata, true),
      meta(USDC), meta(key('delegate')), meta(b.context.treasury, false, true)]);
    const bytes = rewrap(...budget(), approve);
    b.intent = boundIntent(bytes, { action: 'approve', amountIn: '100' });
    expect(action(b, 2, 'token.approveChecked').amount).toBe(100n);
    expect(decode(bytes)[2].amount).toBe(100000001n);
    expectPolicyDeny(b);
  });
  it('message decode rejects durable nonce at index 2 before comparing supplied wrap actions', async () => {
    const b = await setup('wrap');
    const ata = b.context.treasuryAtas.get(WSOL).ata;
    const nonce = ix(SYSTEM, u32(4), [meta(key('nonce-account'), true), meta(key('recent-blockhashes')),
      meta(b.context.treasury, false, true)]);
    const transfer = ix(SYSTEM, systemData('100'), [meta(b.context.treasury, true, true), meta(ata, true)]);
    const sync = ix(TOKEN, Buffer.from([17]), [meta(ata, true)]);
    const bytes = rewrap(...budget(), nonce, transfer, sync);
    b.intent = boundIntent(bytes, { action: 'transfer', venue: 'system', tokenIn: { mint: WSOL, symbol: 'wSOL', decimals: 9 }, amountIn: '100' });
    expectDeny(() => decode(bytes), 'SOL_DENY_DURABLE_NONCE', 2);
    expectPolicyDeny(b, 'SOL_DENY_DURABLE_NONCE', 2);
  });

  const orderCases: Array<[string, string, string, number | undefined, (b: Baseline) => void]> = [
    ['payer/wallet (2)', 'approve', 'SOL_DENY_AUTHORITY_NOT_TREASURY', undefined, b => {
      b.context.treasury = key('other-owner'); b.intent.wallet = key('other-owner');
    }],
    ['programIds (3)', 'approve', 'SOL_DENY_PROGRAM_IDS_MISMATCH', undefined, b => { b.intent.programIds = []; }],
    ['program admission (4)', 'approve', 'SOL_DENY_PROGRAM_NOT_ENABLED', 2, b => {
      b.context.config.programs = b.context.config.programs.filter((p: string) => p !== TOKEN);
    }],
    ['compute cap (5)', 'approve', 'SOL_DENY_COMPUTE_BUDGET_CAP', undefined, b => {
      b.context.config.fees.maxComputeUnitLimit = b.intent.tx.computeUnitLimit - 1;
    }],
    ['natural R3 ATA owner fault (6)', 'policy-R3', 'SOL_DENY_ATA_OWNER_NOT_TREASURY', 2, () => {}],
    ['unexpected revoke in message (7)', 'unexpected-revoke', 'SOL_DENY_UNEXPECTED_ACTION', 3, () => {}],
    ['mint removed (8)', 'approve', 'SOL_DENY_MINT_NOT_ALLOWED', 2, b => { delete b.context.config.mints[USDC]; }],
    ['zero token cap (9)', 'approve', 'SOL_DENY_TOKEN_CAP', undefined, b => { b.context.config.tokenCaps[USDC] = '0'; }],
  ];
  for (const [name, id, laterReason, index, fault] of orderCases) {
    it(`actions mismatch precedes ${name}`, async () => {
      const b = await setup(id); fault(b);
      // Verify the competing fault is reachable with unchanged decoded evidence.
      expectPolicyDeny(b, laterReason, index);
      if (id === 'policy-R3') action(b, 3, 'token.transferChecked').amount += 1n;
      else action(b, 2, 'token.approveChecked').untrustedExtra = true;
      expectPolicyDeny(b);
    });
  }
});
