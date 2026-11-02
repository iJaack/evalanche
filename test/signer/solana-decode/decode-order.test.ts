import { describe, expect, it } from 'vitest';
import { budget, expectDeny, ix, key, mod, parse, requireFn, rewrap, SYSTEM, TOKEN, u32 } from './helpers';
import { COMPUTE, JUPITER, loadedData } from '../solana-message-helpers';
const unknown = () => ix(key('prediction-market-stand-in'), Buffer.from([0]));
const tokenDenied = () => ix(TOKEN, Buffer.from([8]));
const systemDenied = () => ix(SYSTEM, u32(3));
const nonce = () => ix(SYSTEM, u32(4));
const cases = [
  { name:'later nonce beats earlier unknown', instructions:[...budget(),unknown(),nonce()],reason:'DURABLE_NONCE',index:3 },
  { name:'later nonce beats earlier denied Token', instructions:[...budget(),tokenDenied(),nonce()],reason:'DURABLE_NONCE',index:3 },
  { name:'earlier unknown beats later denied System', instructions:[...budget(),unknown(),systemDenied()],reason:'PROGRAM_UNKNOWN',index:2 },
  { name:'instruction error beats missing price cardinality', instructions:[budget()[0],ix(COMPUTE,loadedData())],reason:'COMPUTE_BUDGET_INSTRUCTION',index:1 },
  { name:'lower denied Token index wins',instructions:[...budget(),tokenDenied(),systemDenied()],reason:'TOKEN_INSTRUCTION',index:2 },
  { name:'lower denied System index wins',instructions:[...budget(),systemDenied(),tokenDenied()],reason:'SYSTEM_INSTRUCTION',index:2 },
];
describe('fixed decoder pre-pass / index / cardinality order',()=>{
  for(const c of cases)it(c.name,()=>{
    const decode=requireFn(mod,'decodeSolanaMessage');
    expectDeny(()=>decode(parse(rewrap(...c.instructions))),'SOL_DENY_'+c.reason,c.index);
  });
  it('Jupiter top-level program stays unknown until PR5',()=>{
    const decode=requireFn(mod,'decodeSolanaMessage');
    expectDeny(()=>decode(parse(rewrap(...budget(),ix(JUPITER,Buffer.alloc(0))))),'SOL_DENY_PROGRAM_UNKNOWN',2);
  });
  it('hard-deny table is frozen with exactly the two unverified names and null IDs',()=>{
    requireFn(mod,'decodeSolanaMessage');
    expect(mod.SOLANA_HARD_DENIED_PROGRAMS).toEqual([
      {name:'Drift BET (prediction markets)',programId:null,status:'TO VERIFY'},
      {name:'Hedgehog Markets',programId:null,status:'TO VERIFY'},
    ]);
    expect(Object.isFrozen(mod.SOLANA_HARD_DENIED_PROGRAMS)).toBe(true);
  });
  it('closed allowlist rejects an unknown prediction-market stand-in (no invented IDs)',()=>{
    const decode=requireFn(mod,'decodeSolanaMessage');
    expectDeny(()=>decode(parse(rewrap(...budget(),unknown()))),'SOL_DENY_PROGRAM_UNKNOWN',2);
  });
});
