import { describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress, MaxUint256 } from 'ethers';
import { LIFI_DIAMOND, KYBER_META_AGGREGATION_ROUTER_V2, decodeCalldata } from '../../src/signer/decode';
import { KYBER, kyberExecution, leg, encodeSingle, encodeMultiple, allowFor, decodeOptions, sign, ATTACKER, KEY, fixture } from './helpers';

const wallet = new Wallet(KEY).address;
function enc(ex: ReturnType<typeof kyberExecution>) { return KYBER.encodeFunctionData('swap', [ex]); }
function dec(data: string, legs: ReturnType<typeof leg>[]) {
  return decodeCalldata(LIFI_DIAMOND, data, decodeOptions(wallet, allowFor(legs, wallet), legs));
}
const SIMPLE = new Interface([
  'function swapSimpleMode(address caller, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes executorData, bytes clientData)',
  'function swapGeneric((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution)',
]);

describe('R8 review: Kyber decoder adversarial', () => {
  it('K1 denies attacker dstReceiver on single leg', () => {
    const ex = kyberExecution(fixture.calldata); ex.desc.dstReceiver = ATTACKER;
    const l = leg(enc(ex)); expect(() => dec(encodeSingle(l, wallet), [l])).toThrow(/dstReceiver/);
  });
  it('K2 denies wallet as intermediate dstReceiver and attacker on leg 2 of 3', () => {
    const ex = kyberExecution(fixture.calldata); ex.desc.dstReceiver = ATTACKER;
    const a = leg(fixture.calldata);
    const b = leg(enc({ ...ex, desc: { ...ex.desc, srcToken: fixture.dstToken, dstToken: fixture.srcToken } }), { sendingAssetId: getAddress(fixture.dstToken), receivingAssetId: getAddress(fixture.srcToken), fromAmount: 1n, requiresDeposit: false });
    const c = leg(fixture.calldata, { fromAmount: 1n, requiresDeposit: false });
    expect(() => dec(encodeMultiple([a, b, c], wallet), [a, b, c])).toThrow(/intermediate/);
  });
  it('K3 dstReceiver zero (Kyber => msg.sender = diamond) is denied (false negative, fail closed)', () => {
    const ex = kyberExecution(fixture.calldata); ex.desc.dstReceiver = '0x0000000000000000000000000000000000000000';
    const l = leg(enc(ex)); expect(() => dec(encodeSingle(l, wallet), [l])).toThrow(/dstReceiver/);
  });
  it('K4 malformed / truncated Kyber calldata denied', () => {
    const l = leg(fixture.calldata.slice(0, 200));
    expect(() => dec(encodeSingle(l, wallet), [l])).toThrow(/could not be decoded/);
    const l2 = leg('0xe21fd0e9' + 'ff'.repeat(64));
    expect(() => dec(encodeSingle(l2, wallet), [l2])).toThrow(/could not be decoded/);
  });
  it('K5 denies trailing junk after valid Kyber calldata', () => {
    const l = leg(fixture.calldata + 'deadbeef'.repeat(8));
    expect(() => dec(encodeSingle(l, wallet), [l])).toThrow(/trailing/);
  });
  it('K6 denies Kyber selectors other than swap', () => {
    const ex = kyberExecution(fixture.calldata); ex.desc.dstReceiver = ATTACKER;
    const simple = SIMPLE.encodeFunctionData('swapSimpleMode', [ATTACKER, ex.desc, '0x01', '0x']);
    const generic = SIMPLE.encodeFunctionData('swapGeneric', [ex]);
    for (const cd of [simple, generic, '0xdeadbeef', '0x']) {
      const l = leg(cd);
      expect(() => dec(encodeSingle(l, wallet), [l])).toThrow(/selector is not swap/);
    }
  });
  it('K7 denies attacker srcReceivers, feeReceivers, and callTarget', async () => {
    const base = kyberExecution(fixture.calldata);
    const cases: Record<string, ReturnType<typeof kyberExecution>> = {
      srcReceivers: { ...base, desc: { ...base.desc, srcReceivers: [ATTACKER], srcAmounts: [BigInt(fixture.amount)] } },
      feeReceivers: { ...base, desc: { ...base.desc, feeReceivers: [ATTACKER], feeAmounts: [BigInt(fixture.amount) / 2n], flags: base.desc.flags } },
      callTarget: { ...base, callTarget: ATTACKER, approveTarget: ATTACKER },
    };
    for (const ex of Object.values(cases)) {
      const l = leg(enc(ex));
      await expect(sign(encodeSingle(l, wallet), [l], wallet)).rejects.toThrow(/executor|fee amount/);
    }
    const inner = { ...base, desc: { ...base.desc, minReturnAmount: 1n } };
    const kept = leg(enc(inner));
    const ok = await sign(encodeSingle(kept, wallet), [kept], wallet);
    expect(ok.signedTransaction).toMatch(/^0x/);
  });
  it('K8 V3 receiver attacker denied; minOut 0 denied', () => {
    const l = leg(fixture.calldata);
    expect(() => dec(encodeSingle(l, ATTACKER), [l])).toThrow();
    expect(() => dec(encodeSingle(l, wallet, 0n), [l])).toThrow(/greater than zero/);
  });
  it('K9 does not inner-decode a non-Kyber dex', () => {
    const other = '0x000000000000000000000000000000000000bEEF';
    const l = leg('0x12345678', { callTo: other, approveTo: other });
    expect(dec(encodeSingle(l, wallet), [l])[0]?.kind).toBe('lifi-swap');
  });
});

describe('R8 review: minOut floor', () => {
  const l = leg(fixture.calldata);
  const data = (min: bigint) => encodeSingle(l, wallet, min);
  it('S1 denies a V3 swap with no quotedAmountOut', async () => {
    await expect(sign(data(1n), [l], wallet, { minAmountOut: '1', quotedAmountOut: undefined })).rejects.toThrow(/quotedAmountOut/);
  });
  it('S2 USDC quote uses the 50 bps stable floor', async () => {
    const q = 1_000_000n;
    await expect(sign(data(994_999n), [l], wallet, { minAmountOut: '1', quotedAmountOut: q.toString() })).rejects.toThrow(/floor/);
    const ok = await sign(data(995_000n), [l], wallet, { minAmountOut: '1', quotedAmountOut: q.toString() });
    expect(ok.signedTransaction).toMatch(/^0x/);
  });
  it('S3 maxSlippageBps above class cap denied; stable class uses 50', async () => {
    await expect(sign(data(970_000n), [l], wallet, { minAmountOut: '1', quotedAmountOut: '1000000', maxSlippageBps: 301 })).rejects.toThrow(/class/);
    await expect(sign(data(990_000n), [l], wallet, { minAmountOut: '1', quotedAmountOut: '1000000' }, { slippageCaps: { stables: [fixture.dstToken] } })).rejects.toThrow(/floor/);
  });
  it('S4 denies a one-unit quote', async () => {
    await expect(sign(data(1n), [l], wallet, { minAmountOut: '1', quotedAmountOut: '1' })).rejects.toThrow(/positive token-unit/);
  });
  it('S5 quotedAmountOut "0" denied', async () => {
    await expect(sign(data(1n), [l], wallet, { minAmountOut: '1', quotedAmountOut: '0' })).rejects.toThrow();
  });
});
void MaxUint256; void KYBER_META_AGGREGATION_ROUTER_V2;
