import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, boundIntent, decode, expectDeny, fromJson, key, mod, parse, policyContext, requireFn,
  toJson, USDC, WSOL, configModule, MAINNET, template } from './helpers';
import { JUPITER, poolFixture } from '../solana-message-helpers';
const vectors:any[]=vectorsJson;
async function setup(v:any){
  const actions=decode(Buffer.from(v.messageHex,'hex'));const intent=structuredClone(v.intent);assertIntent(intent);
  const payer=parse(Buffer.from(v.messageHex,'hex')).staticAccountKeys[0];const context=await policyContext(payer,v.configProfile);
  return {actions,intent,context};
}
describe('PR3 policy and exact principal/rent/fee accounting',()=>{
  it('consumes exactly 52 shared policy vectors (14 positives and 38 negatives)',()=>{
    expect(vectors.length).toBeGreaterThan(0);expect(vectors).toHaveLength(52);
    expect(vectors.filter(v=>v.expected.actions)).toHaveLength(14);expect(vectors.filter(v=>v.expected.deny)).toHaveLength(38);
    expect(new Set(vectors.map(v=>v.id)).size).toBe(52);
  });
  for(const v of vectors)it(`${v.id}: ${v.expected.deny??'exact actions and SolanaDebitSummary'}`,async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(v);
    if(v.expected.deny)expectDeny(()=>check(actions,context,intent),v.expected.deny,v.expected.instructionIndex);
    else {
      expect(actions).toEqual(fromJson(v.expected.actions));expect(toJson(actions)).toEqual(v.expected.actions);
      const summary=check(actions,context,intent);
      const expected={...fromJson(v.expected.debitSummary),debits:Object.fromEntries(Object.entries(v.expected.debitSummary.debits).map(([k,n])=>[k,BigInt(n as string)]))};
      expect(summary).toEqual(expected);expect(toJson(summary)).toEqual(v.expected.debitSummary);
      expect(typeof summary.priorityFeeLamports).toBe('bigint');
    }
  });
  it.each(['01','-1','1.5','','18446744073709551616',5])('wSOL unwrap malformed amountIn %j is rejected directly by policy',async amountIn=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='unwrap-0'));
    // Baseline is PR1-valid. Deliberately bypass the schema for this defense-in-depth contract.
    expect(check(actions,context,intent)).toEqual({debits:{},newAccounts:[],priorityFeeLamports:1000000n});
    intent.amountIn=amountIn;expectDeny(()=>check(actions,context,intent),'SOL_DENY_AMOUNT_MISMATCH',2);
  });
  it('wSOL unwrap requires amountIn to be present, even with no principal debit',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='unwrap-0'));
    delete intent.amountIn;expectDeny(()=>check(actions,context,intent),'SOL_DENY_AMOUNT_MISMATCH',2);
  });
  it('wSOL unwrap accepts the canonical u64 upper bound without adding a wSOL debit',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='unwrap-0'));
    intent.amountIn='18446744073709551615';assertIntent(intent);
    expect(check(actions,context,intent)).toEqual({debits:{},newAccounts:[],priorityFeeLamports:1000000n});
  });
  it.each(['computeUnitLimit','computeUnitPriceMicroLamports'])('intent tx.%s must equal message budget',async field=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='wrap'));
    intent.tx[field]=field==='computeUnitLimit'?399999:'2499999';assertIntent(intent);
    expectDeny(()=>check(actions,context,intent),'SOL_DENY_COMPUTE_BUDGET_MISMATCH');
  });
  it('Jupiter swap intent is denied even with enabled Jupiter, valid pool and program admission',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const base=vectors.find(v=>v.id==='approve');const bytes=Buffer.from(base.messageHex,'hex');
    const intent=boundIntent(bytes,{action:'swap',venue:'jupiter-v6',tokenIn:{mint:USDC,symbol:'USDC',decimals:6},amountIn:'100',
      tokenOut:{mint:WSOL,symbol:'wSOL',decimals:9},minAmountOut:'1',quotedAmountOut:'2',slippageBps:100,maxSlippageBps:100,quoteId:'offline-pr3',quotedAt:1793542490000});
    const pool=poolFixture();const input=template();const c=input.clusters[MAINNET];c.jupiter.enabled=true;c.jupiter.pools=[pool];c.innerPrograms=[pool.ammProgram];
    const resolved=requireFn(configModule,'resolveSolanaConfig')(input);const context=await policyContext();context.config=resolved.clusters[MAINNET];
    expect(context.config.programs).toContain(JUPITER);expect(context.config.jupiter.enabled).toBe(true);
    expectDeny(()=>check(decode(bytes),context,intent),'SOL_DENY_PROGRAM_NOT_ENABLED');
  });
  it('policy independently binds the actual message payer even if intent.wallet equals treasury',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='approve'));
    context.treasury=key('other-owner');intent.wallet=context.treasury;assertIntent(intent);
    expectDeny(()=>check(actions,context,intent),'SOL_DENY_AUTHORITY_NOT_TREASURY');
  });
  it('an omitted configured program denies enablement after correct programIds',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const {actions,intent,context}=await setup(vectors.find(v=>v.id==='approve'));
    context.config.programs=context.config.programs.filter((p:string)=>p!==actions[2].programId);
    expectDeny(()=>check(actions,context,intent),'SOL_DENY_PROGRAM_NOT_ENABLED',2);
  });
});
