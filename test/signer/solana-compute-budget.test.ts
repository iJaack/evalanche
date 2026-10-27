import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intentModule from '../../src/signer/intent';
import { requireFn } from './solana-test-helpers';
import { heapFrameData, instruction, limitData, loadedData, messageIntent, messageSpec, priceData, TOKEN } from './solana-message-helpers';

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 compute test: fetch forbidden'); });
  vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => { try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });
const CAPS = { maxComputeUnitLimit: 400000, maxComputeUnitPriceMicroLamports: '2500000', maxPriorityFeeLamports: '1000000' };

describe('PR2 bigint priority fee arithmetic', () => {
  it.each([
    [400000, '2500000', 1000000n], [400000, '2500001', 1000001n], [1, '1', 1n],
    [400000, 2500000n, 1000000n], [1, 0n, 0n],
    [400000, '18446744073709551615', 7378697629483820646n],
    [Number.MAX_SAFE_INTEGER, '18446744073709551615', (9007199254740991n * 18446744073709551615n + 999999n) / 1000000n],
  ])('ceil(%s * %s / 1e6) is %s lamports', (limit, price, expected) => {
    const fee = requireFn(intentModule, 'solanaPriorityFeeLamports');
    expect(fee(limit, price)).toBe(expected);
  });
});

describe('PR2 ComputeBudget instruction contract', () => {
  it.each(['normal', 'reversed', 'separated'])('accepts exactly one limit and one price in %s order', (order) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec();
    if (order === 'reversed') spec.instructions.reverse();
    if (order === 'separated') spec.instructions = [spec.instructions[0], spec.instructions[2], spec.instructions[1]];
    expect(match(messageIntent(spec)).version).toBe(0);
  });
  it.each([
    ['missing limit', (s: ReturnType<typeof messageSpec>) => { s.instructions.splice(0, 1); }],
    ['missing price', (s: ReturnType<typeof messageSpec>) => { s.instructions.splice(1, 1); }],
    ['both missing', (s: ReturnType<typeof messageSpec>) => { s.instructions = s.instructions.slice(2); }],
    ['duplicate identical limit', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(limitData())); }],
    ['duplicate different limit', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(limitData(399999))); }],
    ['duplicate identical price', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(priceData())); }],
    ['duplicate different price', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(priceData('1'))); }],
    ['heap frame', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(heapFrameData())); }],
    ['loaded account data size', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(loadedData())); }],
    ['unknown discriminator', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(Buffer.from([255]))); }],
    ['deprecated request units', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(Buffer.alloc(9))); }],
    ['empty compute data', (s: ReturnType<typeof messageSpec>) => { s.instructions.push(instruction(Buffer.alloc(0))); }],
    ['limit from another program', (s: ReturnType<typeof messageSpec>) => { s.instructions[0].programIdIndex = 2; }],
    ['price from another program', (s: ReturnType<typeof messageSpec>) => { s.instructions[1].programIdIndex = 2; }],
  ] as const)('denies %s', (_name, mutate) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); mutate(spec);
    expect(() => match(messageIntent(spec))).toThrow();
  });
  it.each([
    ['limit short', 0, limitData().subarray(0, 4)], ['limit trailing', 0, Buffer.concat([limitData(), Buffer.from([0])])],
    ['price short', 1, priceData().subarray(0, 8)], ['price trailing', 1, Buffer.concat([priceData(), Buffer.from([0])])],
  ] as const)('denies wrong exact length: %s', (_name, index, data) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); spec.instructions[index].data = data;
    expect(() => match(messageIntent(spec))).toThrow();
  });
  it.each(['computeUnitLimit', 'computeUnitPriceMicroLamports'])('denies a schema-valid tx.%s mismatch', (field) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const intent = messageIntent();
    intent.tx[field] = field === 'computeUnitLimit' ? 399999 : '2499999';
    expect(() => match(intent)).toThrow();
  });
  it('does not treat ComputeBudget-looking bytes from SPL Token as extra budgets', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec();
    spec.instructions.push(instruction(limitData(), 2), instruction(priceData(), 2));
    expect(match(messageIntent(spec)).instructions.at(-1).programId).toBe(TOKEN);
  });
  it('decodes the maximum u32 limit and u64 price exactly when no caps are supplied', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec();
    spec.instructions[0].data = limitData(4294967295); spec.instructions[1].data = priceData('18446744073709551615');
    expect(match(messageIntent(spec, 4294967295, '18446744073709551615')).version).toBe(0);
  });
  it('denies a wire zero limit even if the intent declares positive units', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); spec.instructions[0].data = limitData(0);
    expect(() => match(messageIntent(spec))).toThrow();
  });
});

describe('PR2 explicit fee caps, with no pending economic defaults', () => {
  it('accepts the exact limit, price and lamport cap', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); expect(match(messageIntent(), { caps: CAPS }).version).toBe(0);
  });
  it.each([
    ['CU limit', { ...CAPS, maxComputeUnitLimit: 399999 }],
    ['CU price', { ...CAPS, maxComputeUnitPriceMicroLamports: '2499999' }],
    ['priority fee', { ...CAPS, maxPriorityFeeLamports: '999999' }],
  ])('denies only the tightened %s cap', (_name, caps) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); expect(() => match(messageIntent(), { caps })).toThrow();
  });
  it('denies one micro-lamport price increment by the rounded priority fee, despite a permissive price cap', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); spec.instructions[1].data = priceData('2500001');
    expect(() => match(messageIntent(spec, 400000, '2500001'), { caps: { ...CAPS, maxComputeUnitPriceMicroLamports: '2500001' } })).toThrow();
  });
  it('accepts that same rounded fee when the lamport cap rises by one', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); spec.instructions[1].data = priceData('2500001');
    expect(match(messageIntent(spec, 400000, '2500001'), { caps: { ...CAPS, maxComputeUnitPriceMicroLamports: '2500001', maxPriorityFeeLamports: '1000001' } }).version).toBe(0);
  });
  it('enforces a bigint priority cap beyond Number safe precision', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec(); spec.instructions[1].data = priceData('18446744073709551615');
    const intent = messageIntent(spec, 400000, '18446744073709551615');
    const caps = { ...CAPS, maxComputeUnitPriceMicroLamports: '18446744073709551615', maxPriorityFeeLamports: '7378697629483820646' };
    expect(match(intent, { caps }).version).toBe(0);
    expect(() => match(intent, { caps: { ...caps, maxPriorityFeeLamports: '7378697629483820645' } })).toThrow();
  });
});
