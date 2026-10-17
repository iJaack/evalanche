import { describe, expect, it } from 'vitest';
import { Wallet, getAddress, AbiCoder } from 'ethers';
import { LIFI_DIAMOND, KYBER_AGGREGATION_EXECUTOR, decodeCalldata } from '../../src/signer/decode';
import { KYBER, kyberExecution, leg, encodeSingle, encodeMultiple, allowFor, decodeOptions, sign, ATTACKER, KEY, fixture } from '../r8review/helpers';

const wallet = new Wallet(KEY).address;
const enc = (ex: ReturnType<typeof kyberExecution>) => KYBER.encodeFunctionData('swap', [ex]);
const dec = (data: string, legs: ReturnType<typeof leg>[]) => decodeCalldata(LIFI_DIAMOND, data, decodeOptions(wallet, allowFor(legs, wallet), legs));
const res = (f: () => unknown) => { try { f(); return 'ALLOWED'; } catch (e) { return 'DENIED ' + (e as Error).message.slice(0, 90); } };
const ares = async (f: () => Promise<unknown>) => { try { await f(); return 'SIGNED'; } catch (e) { return 'DENIED ' + (e as Error).message.slice(0, 90); } };
const base = () => kyberExecution(fixture.calldata);
const amt = BigInt(fixture.amount);

describe('R9 Kyber parties', () => {
  it('P0 fixture baseline', () => {
    const b = base();
    console.log('P0 callTarget', b.callTarget, 'approveTarget', b.approveTarget, 'srcReceivers', b.desc.srcReceivers, 'fees', b.desc.feeReceivers, b.desc.feeAmounts, 'exec const', KYBER_AGGREGATION_EXECUTOR);
    const l = leg(fixture.calldata);
    const decoded = res(() => dec(encodeSingle(l, wallet), [l]));
    console.log('P0 decode fixture:', decoded);
    expect(decoded).toBe('ALLOWED');
  });
  it('P1 srcReceiver=attacker hidden in targetData (substring check)', () => {
    const b = base();
    const td = b.targetData + ATTACKER.slice(2).toLowerCase();
    const ex = { ...b, targetData: td, desc: { ...b.desc, srcReceivers: [ATTACKER], srcAmounts: [amt] } };
    const l = leg(enc(ex));
    const full = res(() => dec(encodeSingle(l, wallet), [l]));
    console.log('P1 full amount to attacker named in appended targetData:', full);
    expect(full.startsWith('DENIED')).toBe(true);
    const ex2 = { ...b, targetData: td, desc: { ...b.desc, srcReceivers: [...b.desc.srcReceivers, ATTACKER], srcAmounts: [...b.desc.srcAmounts.slice(0, -1), b.desc.srcAmounts[b.desc.srcAmounts.length - 1] - amt / 100n, amt / 100n] } };
    const l2 = leg(enc(ex2));
    const split = res(() => dec(encodeSingle(l2, wallet), [l2]));
    console.log('P1b 1% split to attacker:', split);
    expect(split.startsWith('DENIED')).toBe(true);
    // unaligned (odd-nibble) match
    const td3 = b.targetData + '0' + ATTACKER.slice(2).toLowerCase() + '0';
    const ex3 = { ...b, targetData: td3, desc: { ...b.desc, srcReceivers: [ATTACKER], srcAmounts: [amt] } };
    const l3 = leg(enc(ex3));
    const odd = res(() => dec(encodeSingle(l3, wallet), [l3]));
    console.log('P1c attacker at odd-nibble offset in targetData:', odd);
    expect(odd.startsWith('DENIED')).toBe(true);
  });
  it('P2 srcAmounts sum mismatch / empty / length mismatch', () => {
    const b = base();
    for (const [n, d] of [
      ['sum+1', { srcReceivers: b.desc.srcReceivers, srcAmounts: b.desc.srcAmounts.map((x, i) => (i === 0 ? x + 1n : x)) }],
      ['empty', { srcReceivers: [], srcAmounts: [] }],
      ['lenmismatch', { srcReceivers: [...b.desc.srcReceivers, KYBER_AGGREGATION_EXECUTOR], srcAmounts: b.desc.srcAmounts }],
      ['zero receiver', { srcReceivers: ['0x0000000000000000000000000000000000000000'], srcAmounts: [amt] }],
    ] as const) {
      const l = leg(enc({ ...b, desc: { ...b.desc, ...(d as object) } } as never));
      const outcome = res(() => dec(encodeSingle(l, wallet), [l]));
      console.log(`P2 ${n}:`, outcome);
      expect(outcome.startsWith('DENIED')).toBe(true);
    }
  });
  it('P3 fees: zero-amount attacker feeReceiver; approveTarget variants', () => {
    const b = base();
    const l = leg(enc({ ...b, desc: { ...b.desc, feeReceivers: [ATTACKER], feeAmounts: [0n] } }));
    console.log('P3 feeReceiver attacker amount 0:', res(() => dec(encodeSingle(l, wallet), [l])));
    const l2 = leg(enc({ ...b, desc: { ...b.desc, feeReceivers: [ATTACKER], feeAmounts: [] } }));
    console.log('P3 fee len mismatch:', res(() => dec(encodeSingle(l2, wallet), [l2])));
    const l3 = leg(enc({ ...b, approveTarget: ATTACKER }));
    console.log('P3 approveTarget attacker:', res(() => dec(encodeSingle(l3, wallet), [l3])));
  });
});

describe('R9 Kyber ABI fuzz', () => {
  const W = 64; // hex chars per word
  function words(cd: string) { const body = cd.slice(10); const out: string[] = []; for (let i = 0; i < body.length; i += W) out.push(body.slice(i, i + W)); return out; }
  function join(ws: string[]) { return '0xe21fd0e9' + ws.join(''); }
  it('F1 every word -> overflow / offset garbage / +32 / 2^255', () => {
    const ws = words(fixture.calldata);
    const tally: Record<string, number> = {};
    const accepted: string[] = [];
    const muts: Array<[string, (w: string) => string]> = [
      ['ffff', () => 'f'.repeat(64)],
      ['2^255', () => '8' + '0'.repeat(63)],
      ['+0x20', (w) => (BigInt('0x' + w) + 32n).toString(16).padStart(64, '0').slice(-64)],
      ['+1', (w) => (BigInt('0x' + w) + 1n).toString(16).padStart(64, '0').slice(-64)],
      ['dirtyhigh', (w) => 'ab' + w.slice(2)],
      ['zero', () => '0'.repeat(64)],
    ];
    for (let i = 0; i < ws.length; i++) {
      for (const [n, m] of muts) {
        const copy = [...ws]; const nw = m(copy[i]); if (nw === copy[i]) continue; copy[i] = nw;
        const l = leg(join(copy));
        const r = res(() => dec(encodeSingle(l, wallet), [l]));
        const key = r.startsWith('ALLOWED') ? 'ALLOWED' : r.slice(0, 60);
        tally[key] = (tally[key] ?? 0) + 1;
        if (r === 'ALLOWED') accepted.push(`w${i}:${n}`);
      }
    }
    console.log('F1 words', ws.length, 'tally', JSON.stringify(tally, null, 1));
    console.log('F1 accepted mutations', accepted.join(' '));
  });
  it('F2 random byte flips (5000), accepted ones must preserve parties', () => {
    const body = fixture.calldata.slice(2);
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    let acc = 0, bad = 0; const badSamples: string[] = [];
    const b0 = base();
    for (let k = 0; k < 5000; k++) {
      const pos = 8 + (rnd() % ((body.length - 8) / 2)) * 2;
      const byte = (rnd() % 256).toString(16).padStart(2, '0');
      const cd = '0x' + body.slice(0, pos) + byte + body.slice(pos + 2);
      const l = leg(cd);
      if (res(() => dec(encodeSingle(l, wallet), [l])) !== 'ALLOWED') continue;
      acc++;
      const e = kyberExecution(cd);
      const ok = getAddress(e.callTarget) === getAddress(b0.callTarget) && e.desc.feeAmounts.every((x: bigint) => x === 0n)
        && [getAddress(LIFI_DIAMOND), wallet].includes(getAddress(e.desc.dstReceiver))
        && e.desc.srcReceivers.every((r: string) => getAddress(r) === getAddress(KYBER_AGGREGATION_EXECUTOR) || e.targetData.toLowerCase().includes(r.slice(2).toLowerCase()));
      if (!ok) { bad++; if (badSamples.length < 5) badSamples.push(`pos${pos}:${byte}`); }
      const srcChanged = e.desc.srcReceivers.join() !== b0.desc.srcReceivers.join();
      if (srcChanged && badSamples.length < 10) badSamples.push(`srcReceivers changed at pos${pos}: ${e.desc.srcReceivers.join(',')}`);
    }
    console.log(`F2 accepted ${acc}/5000, party-violating ${bad}`, badSamples.join(' | '));
    expect(bad).toBe(0);
  }, 300_000);
  it('F3 nested/oversized arrays and trailing bytes on outer V3 calldata', () => {
    const b = base();
    const many = Array.from({ length: 300 }, () => KYBER_AGGREGATION_EXECUTOR);
    const l = leg(enc({ ...b, desc: { ...b.desc, srcReceivers: many, srcAmounts: many.map((_, i) => (i === 0 ? amt : 0n)) } }));
    console.log('F3 300 srcReceivers (all executor, sum ok):', res(() => dec(encodeSingle(l, wallet), [l])));
    const lf = leg(fixture.calldata);
    console.log('F3 outer V3 + trailing junk:', res(() => dec(encodeSingle(lf, wallet) + 'deadbeef'.repeat(8), [lf])));
    console.log('F3 outer V3 + 1 trailing byte:', res(() => dec(encodeSingle(lf, wallet) + 'ff', [lf])));
    const coder = AbiCoder.defaultAbiCoder(); void coder;
    // length word huge for targetData
    const ws = fixture.calldata.slice(10);
    const huge = '0xe21fd0e9' + ws.slice(0, 64 * 7) + 'f'.repeat(64) + ws.slice(64 * 8);
    const lh = leg(huge);
    console.log('F3 huge length at word 7:', res(() => dec(encodeSingle(lh, wallet), [lh])));
  });
  it('F4 multi-leg: Kyber leg with non-executor callTarget hidden at leg 2', () => {
    const b = base();
    const a = leg(fixture.calldata);
    const bad = leg(enc({ ...b, callTarget: ATTACKER, desc: { ...b.desc, srcToken: fixture.dstToken, dstToken: fixture.srcToken } }), { sendingAssetId: getAddress(fixture.dstToken), receivingAssetId: getAddress(fixture.srcToken), fromAmount: 1n, requiresDeposit: false });
    const c = leg(fixture.calldata, { fromAmount: 1n, requiresDeposit: false });
    console.log('F4 leg2 attacker callTarget:', res(() => dec(encodeMultiple([a, bad, c], wallet), [a, bad, c])));
    const lowered = leg(fixture.calldata, { callTo: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5' });
    console.log('F4 lowercase router callTo:', res(() => dec(encodeSingle(lowered, wallet), [lowered])));
  });
});

describe('R9 quote floor', () => {
  const l = leg(fixture.calldata);
  const data = (min: bigint) => encodeSingle(l, wallet, min);
  it('Q1 degenerate quotes', async () => {
    for (const [q, m, bps] of [['1', 1n, undefined], ['2', 1n, undefined], ['3', 2n, undefined], ['200', 199n, undefined], ['2', 1n, 0], ['10', 1n, -5000]] as const) {
      const over: Record<string, unknown> = { minAmountOut: '1', quotedAmountOut: q };
      if (bps !== undefined) over.maxSlippageBps = bps;
      console.log(`Q1 quote=${q} minOut=${m} bps=${bps}:`, await ares(() => sign(data(m), [l], wallet, over)));
    }
  });
  it('Q2 quote parsing oddities', async () => {
    for (const q of ['0x10', ' 5', '-5', '1e3', '01000000', '']) {
      console.log(`Q2 quote=${JSON.stringify(q)}:`, await ares(() => sign(data(BigInt(fixture.minReturnAmount)), [l], wallet, { quotedAmountOut: q })));
    }
  });
  it('Q3 quote above tokenOut cap denied', async () => {
    console.log('Q3 quote > cap:', await ares(() => sign(data(BigInt(fixture.minReturnAmount)), [l], wallet, { quotedAmountOut: fixture.minReturnAmount }, { tokenCaps: { [getAddress(fixture.dstToken)]: '1', [getAddress(fixture.srcToken)]: fixture.amount } })));
  });
  it('Q4 C3 classes: USDC 50, WAVAX/BTC.b/WETH.e/sAVAX 200, other 300', async () => {
    const { tokenClassBps } = await import('../../src/signer/server');
    for (const a of ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', '0x152b9d0FdC40C096757F570A51E494bd4b943E50', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', ATTACKER, 'garbage']) {
      console.log('Q4', a, tokenClassBps(undefined, a), 'withCfgTopUSDC', tokenClassBps({ top: ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'] } as never, a), 'stableBps=500', tokenClassBps({ stableBps: 500 } as never, a));
    }
  });
});
