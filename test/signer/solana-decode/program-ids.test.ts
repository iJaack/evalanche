import { describe, expect, it } from 'vitest';
import mainnet from '../fixtures/solana-decode/mainnet-messages.json';
import policyVectors from '../fixtures/solana-decode/policy-vectors.json';
import { ATA, assertIntent, boundIntent, budget, decode, expectDeny, ix, key, meta, mod, parse, policyContext,
  requireFn, rewrap, SYSTEM, TOKEN, USDC, COMPUTE } from './helpers';
describe('sorted union of top-level and implied CPI program ids',()=>{
  for(const v of mainnet.slice(0,3))it(`${v.id}: exact sorted set`,()=>{
    const derive=requireFn(mod,'derivedProgramIds');const message=parse(Buffer.from(v.messageHex,'hex'));
    const sets:Record<string,string[]>={R1:[SYSTEM,COMPUTE].sort(),R2:[COMPUTE,TOKEN].sort(),R3:[SYSTEM,ATA,COMPUTE,TOKEN].sort()};
    expect(derive(message,decode(Buffer.from(v.messageHex,'hex')))).toEqual(sets[v.id]);
    expect(derive(message,decode(Buffer.from(v.messageHex,'hex')))).toEqual(v.expectedProgramIds);
  });
  it('ATA-only top level implies System and Token, with default JS string ordering',()=>{
    const derive=requireFn(mod,'derivedProgramIds');const i=ix(ATA,Buffer.from([1]),[meta(key('treasury'),true,true),meta(key('ata'),true),meta(key('treasury')),meta(USDC),meta(SYSTEM),meta(TOKEN)]);
    const bytes=rewrap(...budget(),i);const message=parse(bytes);
    expect(message.instructions.map((i:any)=>i.programId)).toEqual([COMPUTE,COMPUTE,ATA]);
    expect(derive(message,decode(bytes))).toEqual([SYSTEM,ATA,COMPUTE,TOKEN].sort());
  });
  it('de-duplicates repeated top-level and implied programs and sorts independently of instruction order',()=>{
    const derive=requireFn(mod,'derivedProgramIds');const v=policyVectors.find(v=>v.id==='wrap-ata-1')!;
    const message=parse(Buffer.from(v.messageHex,'hex'));const actions=decode(Buffer.from(v.messageHex,'hex'));
    message.instructions.reverse();actions.reverse();
    expect(derive(message,actions)).toEqual([SYSTEM,ATA,COMPUTE,TOKEN].sort());
  });
  it.each(['omit implied System','extra program','correct'])('policy programIds: %s',async mutation=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const v=policyVectors.find(v=>v.id==='usdc-ata-1')!;
    const bytes=Buffer.from(v.messageHex,'hex');const intent=boundIntent(bytes);const actions=decode(bytes);const context=await policyContext();
    if(mutation==='omit implied System')intent.programIds=intent.programIds.filter((p:string)=>p!==SYSTEM);
    if(mutation==='extra program')intent.programIds=[...intent.programIds,key('extra-program')].sort();assertIntent(intent);
    if(mutation==='correct')expect(check(actions,context,intent)).toEqual({debits:{},newAccounts:[{address:context.treasuryAtas.get(USDC).ata,tokenProgram:TOKEN,expectedSpace:165}],priorityFeeLamports:1000000n});
    else expectDeny(()=>check(actions,context,intent),'SOL_DENY_PROGRAM_IDS_MISMATCH');
  });
});
