import { describe, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, boundIntent, budget, checkedData, decode, expectDeny, ix, key, meta, mod, policyContext,
  requireFn, rewrap, TOKEN, USDC, USDT, WSOL } from './helpers';
const vectors:any[]=vectorsJson;
async function baseline(id='approve'){
  const v=vectors.find(v=>v.id===id);const bytes=Buffer.from(v.messageHex,'hex');
  return {bytes,actions:decode(bytes),intent:structuredClone(v.intent),context:await policyContext()};
}
describe('fixed policy steps 2–9: earlier fault wins',()=>{
  it('payer/wallet (2) beats programIds (3)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline();b.intent.wallet=key('other-owner');b.intent.programIds=[];assertIntent(b.intent);
    expectDeny(()=>check(b.actions,b.context,b.intent),'SOL_DENY_AUTHORITY_NOT_TREASURY');
  });
  it('programIds (3) beats Jupiter enablement (4)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline();
    const intent=boundIntent(b.bytes,{action:'swap',venue:'jupiter-v6',tokenOut:{mint:WSOL,symbol:'wSOL',decimals:9},minAmountOut:'1',quotedAmountOut:'2',slippageBps:100,maxSlippageBps:100,quoteId:'offline-order',quotedAt:1793542490000});
    intent.programIds=[];assertIntent(intent);expectDeny(()=>check(b.actions,b.context,intent),'SOL_DENY_PROGRAM_IDS_MISMATCH');
  });
  it('program enablement (4) beats CU caps (5)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline('units-over-cap');b.context.config.programs=b.context.config.programs.filter((p:string)=>p!==TOKEN);
    expectDeny(()=>check(b.actions,b.context,b.intent),'SOL_DENY_PROGRAM_NOT_ENABLED',2);
  });
  it('CB cap (5) beats recipient (6)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline('recipient-other-owner-ata');b.context.config.fees.maxComputeUnitLimit=399999;
    expectDeny(()=>check(b.actions,b.context,b.intent),'SOL_DENY_COMPUTE_BUDGET_CAP');
  });
  it('recipient (6) beats wrap shape (7): R1 has neither treasury output nor syncNative',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const v=vectors.find(v=>v.id==='policy-R1');const bytes=Buffer.from(v.messageHex,'hex');
    const context=await policyContext(v.intent.wallet);assertIntent(v.intent);
    expectDeny(()=>check(decode(bytes),context,v.intent),'SOL_DENY_RECIPIENT_NOT_TREASURY',2);
  });
  it('shape (7) beats mint allowlist (8)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline();
    // Valid treasury approve plus an unexpected revoke; removing the approve mint is the second fault.
    const revoke=ix(TOKEN,Buffer.from([5]),[meta(b.context.treasuryAtas.get(USDC).ata,true),meta(b.context.treasury,true,true)]);
    const approve=ix(TOKEN,checkedData(),[meta(b.context.treasuryAtas.get(USDC).ata,true),meta(USDC),meta(key('delegate')),meta(b.context.treasury,true,true)]);
    const bytes=rewrap(...budget(),approve,revoke);const intent=boundIntent(bytes,{action:'approve',amountIn:'100'});
    delete b.context.config.mints[USDC];expectDeny(()=>check(decode(bytes),b.context,intent),'SOL_DENY_UNEXPECTED_ACTION',3);
  });
  it('mint allowlist (8) beats spending caps (9)',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline();
    delete b.context.config.mints[USDC];b.context.config.tokenCaps[USDC]='0';
    expectDeny(()=>check(b.actions,b.context,b.intent),'SOL_DENY_MINT_NOT_ALLOWED',2);
  });
  it('recipient on an earlier action beats authority on a later action',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline('close-wrong-destination');
    const later={...b.actions[2],instructionIndex:3,destination:b.context.treasury,owner:key('other-owner')};
    // Defense in depth over supplied decoded actions; later owner cannot be a valid phase-1 signer.
    expectDeny(()=>check([...b.actions,later],b.context,b.intent),'SOL_DENY_RECIPIENT_NOT_TREASURY',2);
  });
  it('authority on an earlier action beats recipient on a later action',async()=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const b=await baseline('usdc-close');
    b.actions[2].owner=key('other-owner');const later={...b.actions[2],instructionIndex:3,owner:b.context.treasury,destination:key('other-owner')};
    expectDeny(()=>check([...b.actions,later],b.context,b.intent),'SOL_DENY_AUTHORITY_NOT_TREASURY',2);
  });
});
