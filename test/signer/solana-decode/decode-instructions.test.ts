/** Layouts pinned to PR3 §3.2, with Builder's whole-program Token-2022 ban.
 * No live source verification or network is performed by these tests. */
import { describe, expect, it } from 'vitest';
import negativesJson from '../fixtures/solana-decode/handbuilt-negatives.json';
import { ATA, budget, checkedData, COMPUTE, expectDeny, inputAt, ix, key, limitData, meta, mod, parse,
  priceData, requireFn, rewrap, SYSTEM, systemData, TOKEN, TOKEN_2022, u32, USDC } from './helpers';
const owner = key('treasury'), source = key('source'), dest = key('destination'), delegate = key('delegate');
const tests = [
  { name: 'limit', decoder: 'decodeComputeBudget', i: ix(COMPUTE, limitData(400000)), fields: { kind: 'computeBudget.setComputeUnitLimit', units: 400000 } },
  { name: 'price', decoder: 'decodeComputeBudget', i: ix(COMPUTE, priceData('18446744073709551615')), fields: { kind: 'computeBudget.setComputeUnitPrice', microLamports: 18446744073709551615n } },
  { name: 'system transfer', decoder: 'decodeSystem', i: ix(SYSTEM, systemData('18446744073709551615'), [meta(owner,true,true),meta(dest,true)]), fields: { kind: 'system.transfer', from: owner, to: dest, lamports: 18446744073709551615n } },
  { name: 'transferChecked', decoder: 'decodeToken', i: ix(TOKEN, checkedData(12,'18446744073709551615',6),[meta(source,true),meta(USDC),meta(dest,true),meta(owner,true,true)]), fields: { kind: 'token.transferChecked', tokenProgram:TOKEN,source,mint:USDC,destination:dest,authority:owner,amount:18446744073709551615n,decimals:6 } },
  { name: 'approveChecked', decoder: 'decodeToken', i: ix(TOKEN, checkedData(13,'9007199254740993',6),[meta(source,true),meta(USDC),meta(delegate),meta(owner,true,true)]), fields: { kind:'token.approveChecked',tokenProgram:TOKEN,source,mint:USDC,delegate,owner,amount:9007199254740993n,decimals:6 } },
  { name: 'revoke', decoder: 'decodeToken', i: ix(TOKEN,Buffer.from([5]),[meta(source,true),meta(owner,true,true)]),fields:{kind:'token.revoke',tokenProgram:TOKEN,source,owner} },
  { name: 'close', decoder: 'decodeToken', i: ix(TOKEN,Buffer.from([9]),[meta(source,true),meta(dest,true),meta(owner,true,true)]),fields:{kind:'token.closeAccount',tokenProgram:TOKEN,account:source,destination:dest,owner} },
  { name: 'syncNative', decoder: 'decodeToken', i: ix(TOKEN,Buffer.from([17]),[meta(source,true)]),fields:{kind:'token.syncNative',tokenProgram:TOKEN,account:source} },
  ...[[],[0],[1]].map(data => ({name:`ATA data ${data.length?data[0]:'empty'}`,decoder:'decodeAta',i:ix(ATA,Buffer.from(data),[meta(owner,true,true),meta(source,true),meta(key('wallet')),meta(USDC),meta(SYSTEM),meta(TOKEN)]),fields:{kind:'ata.create',mode:data[0]===1?'createIdempotent':'create',payer:owner,ata:source,wallet:key('wallet'),mint:USDC,tokenProgram:TOKEN,impliedCpiPrograms:[SYSTEM,TOKEN]}})),
];
function input(i: any) { return inputAt(parse(rewrap(i)), 0); }

describe('exact allowed layouts and one-mutation errors', () => {
  for (const t of tests) {
    it(`${t.name}: exact action, including bigint values`, () => {
      expect(requireFn(mod,t.decoder)(input(t.i))).toEqual({instructionIndex:0,programId:t.i.program,...t.fields});
    });
    for (const change of ['short','trailing','extra account', ...(t.i.accounts.length ? ['missing account'] : [])]) {
      // Empty ATA is itself valid, and a one-byte token truncation loses the discriminator.
      if (change==='short' && (t.i.data.length<=1)) continue;
      if (change==='trailing' && t.i.program===ATA && t.i.data.length===0) continue; // [] + [0] is also allowed.
      it(`${t.name}: ${change} throws instead of returning a partial action`, () => {
        const decode=requireFn(mod,t.decoder); const i=structuredClone(t.i);
        if(change==='short')i.data=i.data.slice(0,-1);
        if(change==='trailing')i.data=Buffer.concat([i.data,Buffer.from([0])]);
        if(change==='extra account')i.accounts.push(meta(key('extra-account')));
        if(change==='missing account')i.accounts.pop();
        let result: unknown = 'not returned';
        expectDeny(()=>{result=decode(input(i));}, 'SOL_DENY_'+(change.includes('account')?'ACCOUNT_COUNT':'DATA_LENGTH'),0);
        expect(result).toBe('not returned');
      });
    }
    // Mutate wire account privileges, then obtain DecodeInstructionInput from the real parser and accountRoles.
    for (let position=0;position<t.i.accounts.length;position++) {
      const account=t.i.accounts[position];
      for (const flag of ['signer','writable'] as const) {
        // Only required signer bits are pinned: recipients may alias the treasury signer.
        if (flag==='signer' && !account.signer) continue;
        // A parsed one-signer message cannot make its payer readonly; test writable flags on other roles.
        if (flag==='writable' && account.address===owner) continue;
        it(`${t.name}: account ${position} wrong ${flag} flag`, () => {
          const decode=requireFn(mod,t.decoder);const i=structuredClone(t.i);
          if(flag==='signer')i.accounts[position]={...account,address:key('unsigned-required-signer'),signer:false};
          else i.accounts[position].writable=!account.writable;
          expectDeny(()=>decode(input(i)),'SOL_DENY_ACCOUNT_FLAGS',0);
        });
      }
    }
  }
  it('consumes exactly seven shared hand-built one-mutation negatives',()=>{
    expect(negativesJson.length).toBeGreaterThan(0);expect(negativesJson).toHaveLength(7);
  });
  for(const v of negativesJson)it(`shared ${v.id}: ${v.mutation}`,()=>{
    const decode=requireFn(mod,'decodeSolanaMessage');expect(v.provenance).toBe('hand-built');
    expectDeny(()=>decode(parse(Buffer.from(v.messageHex,'hex'))),v.expected.deny,v.expected.instructionIndex);
  });
});

describe('closed discriminator tables',()=>{
  it.each([0,1,3,5,6,7,8,9,10,11,12,13,255])('System tag %i is forbidden',tag=>{
    const decode=requireFn(mod,'decodeSystem');expectDeny(()=>decode(input(ix(SYSTEM,u32(tag)))),'SOL_DENY_SYSTEM_INSTRUCTION',0);
  });
  it('System AdvanceNonce tag 4 is durable nonce',()=>{
    const decode=requireFn(mod,'decodeSystem');expectDeny(()=>decode(input(ix(SYSTEM,u32(4)))),'SOL_DENY_DURABLE_NONCE',0);
  });
  it.each([3,4])('classic Token unchecked tag %i',tag=>{
    const decode=requireFn(mod,'decodeToken');expectDeny(()=>decode(input(ix(TOKEN,Buffer.from([tag])))),'SOL_DENY_TOKEN_UNCHECKED',0);
  });
  it('classic Token InitializeAccount3 at top level',()=>{
    const decode=requireFn(mod,'decodeToken');expectDeny(()=>decode(input(ix(TOKEN,Buffer.concat([Buffer.from([18]),Buffer.alloc(32)])))),'SOL_DENY_TOKEN_INIT_OUTSIDE_ATA',0);
  });
  it.each([0,1,2,6,7,8,10,11,14,15,16,19,20,21,22,23,24,...Array.from({length:20},(_,i)=>25+i),255])('classic Token forbidden tag %i',tag=>{
    const decode=requireFn(mod,'decodeToken');expectDeny(()=>decode(input(ix(TOKEN,Buffer.from([tag])))),'SOL_DENY_TOKEN_INSTRUCTION',0);
  });
  it.each([2,3])('ATA tag %i forbidden',tag=>{
    const decode=requireFn(mod,'decodeAta');expectDeny(()=>decode(input(ix(ATA,Buffer.from([tag])))),'SOL_DENY_ATA_INSTRUCTION',0);
  });
  it('ATA with Token-2022 account is denied at that index',()=>{
    const decode=requireFn(mod,'decodeAta');const i=structuredClone(tests.at(-1)!.i);i.accounts[5]=meta(TOKEN_2022);
    expectDeny(()=>decode(input(i)),'SOL_DENY_PROGRAM_NOT_ENABLED',0);
    expectDeny(()=>requireFn(mod,'decodeSolanaMessage')(parse(rewrap(...budget(),i))),'SOL_DENY_PROGRAM_NOT_ENABLED',2);
  });
  it.each([0,1,4,5,255])('ComputeBudget unknown tag %i',tag=>{
    const decode=requireFn(mod,'decodeComputeBudget');expectDeny(()=>decode(input(ix(COMPUTE,Buffer.from([tag])))),'SOL_DENY_COMPUTE_BUDGET_INSTRUCTION',0);
  });
  it.each(['missing limit','missing price','duplicate limit','duplicate price'])('ComputeBudget cardinality: %s',change=>{
    const decode=requireFn(mod,'decodeSolanaMessage');const instructions=budget();
    if(change==='missing limit')instructions.splice(0,1);if(change==='missing price')instructions.splice(1,1);
    if(change==='duplicate limit')instructions.push(budget()[0]);if(change==='duplicate price')instructions.push(budget()[1]);
    expectDeny(()=>decode(parse(rewrap(...instructions))),'SOL_DENY_COMPUTE_BUDGET_CARDINALITY');
  });
});

describe('Token-2022 whole-program ban precedes all structure checks',()=>{
  for(let tag=0;tag<=255;tag++)it(`tag ${tag}: direct and message decoding, arbitrary lengths and accounts`,()=>{
    const decode=requireFn(mod,'decodeToken');const messageDecode=requireFn(mod,'decodeSolanaMessage');
    for(const length of [1,2,10,33,100])for(const accounts of [[],[meta(owner,true,true)],[meta(source,true),meta(USDC),meta(dest,true),meta(owner,true,true)],Array.from({length:7},()=>meta(source))]){
      const data=Buffer.alloc(length,255);data[0]=tag;const i=ix(TOKEN_2022,data,accounts);
      expectDeny(()=>decode(input(i)),'SOL_DENY_PROGRAM_NOT_ENABLED',0);
      expectDeny(()=>messageDecode(parse(rewrap(...budget(),i))),'SOL_DENY_PROGRAM_NOT_ENABLED',2);
    }
  });
  it('empty Token-2022 data and account list',()=>{
    const decode=requireFn(mod,'decodeToken');
    for(const accounts of [[],[meta(owner,true,true)],[meta(source,true),meta(USDC),meta(dest,true),meta(owner,true,true)]]) {
      const i=ix(TOKEN_2022,Buffer.alloc(0),accounts);
      expectDeny(()=>decode(input(i)),'SOL_DENY_PROGRAM_NOT_ENABLED',0);
      expectDeny(()=>requireFn(mod,'decodeSolanaMessage')(parse(rewrap(...budget(),i))),'SOL_DENY_PROGRAM_NOT_ENABLED',2);
    }
  });
});
