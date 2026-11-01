import { describe, expect, it } from 'vitest';
import { key, MINTS, mod, oracleAta, requireFn, TOKEN, USDC, USDT, WSOL } from './helpers';
const R3_WALLET='R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX';
const R3_PAYER='oMcssxWxgooErb8bsRA4QN34VHhvfeEbdDjrwF6WH45';
const R3_ATA='HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq';
describe('treasury ATA derivation against independent @solana/addresses oracle',()=>{
  for(const wallet of [key('treasury'),R3_WALLET,R3_PAYER])for(const mint of [WSOL,USDC,USDT])it(`${wallet} / ${mint}`,async()=>{
    const derive=requireFn(mod,'deriveTreasuryAtas');const expected=await oracleAta(wallet,mint);
    const map=await derive(wallet,MINTS);expect(map.size).toBe(3);
    expect(map.get(mint)).toEqual({ata:expected[0],tokenProgram:TOKEN});
  });
  it('pins R3 third-party USDC wallet, ATA and bump 255; fee payer differs',async()=>{
    const derive=requireFn(mod,'deriveTreasuryAtas');const [address,bump]=await oracleAta(R3_WALLET,USDC);
    expect(address).toBe(R3_ATA);expect(bump).toBe(255);
    const map=await derive(R3_WALLET,MINTS);expect(map.get(USDC)).toEqual({ata:R3_ATA,tokenProgram:TOKEN});
    const payerMap=await derive(R3_PAYER,MINTS);expect(payerMap.get(USDC).ata).not.toBe(R3_ATA);
  });
  it('reverse lookup returns the mint for each ATA and undefined for unknown',async()=>{
    const lookup=requireFn(mod,'treasuryAtaOwnerOf');const map=await requireFn(mod,'deriveTreasuryAtas')(key('treasury'),MINTS);
    for(const mint of [WSOL,USDC,USDT])expect(lookup(map,map.get(mint).ata)).toBe(mint);
    expect(lookup(map,key('unknown-account'))).toBeUndefined();
  });
});
