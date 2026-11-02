import { describe, expect, it } from 'vitest';
import * as signer from '../../../src/signer/index';
import * as publicApi from '../../../src/index';
import vectors from '../fixtures/solana-decode/mainnet-messages.json';
import { mod, parse, requireFn } from './helpers';
const names=['accountRoles','decodeComputeBudget','decodeSystem','decodeToken','decodeAta','decodeSolanaMessage',
  'derivedProgramIds','deriveTreasuryAtas','treasuryAtaOwnerOf','assertSolanaActionsAllowed','SolanaPolicyDenial','SOLANA_HARD_DENIED_PROGRAMS'];
describe('public decoder export identity',()=>{
  it.each(names)('%s exists and is the same object in both public barrels',name=>{
    if(name==='SOLANA_HARD_DENIED_PROGRAMS')requireFn(mod,'decodeSolanaMessage');else requireFn(mod,name);
    expect(mod[name]).toBeDefined();expect((signer as any)[name]).toBe(mod[name]);expect((publicApi as any)[name]).toBe(mod[name]);
  });
  it('SolanaPolicyDenial constructor preserves exact reason, prefix and index',()=>{
    const Denial=requireFn(mod,'SolanaPolicyDenial');
    const error=new (Denial as any)('SOL_DENY_ACCOUNT_COUNT','instruction 7 requires two accounts',7);
    expect(error).toBeInstanceOf(Error);expect(error.reason).toBe('SOL_DENY_ACCOUNT_COUNT');expect(error.instructionIndex).toBe(7);
    expect(error.message).toBe('SOL_DENY_ACCOUNT_COUNT: instruction 7 requires two accounts');
  });
  it('R3 account roles are exact for all ten keys (header [1,0,6])',()=>{
    const roles=requireFn(mod,'accountRoles');const r3=vectors.find(v=>v.id==='R3')!;const message=parse(Buffer.from(r3.messageHex,'hex'));
    expect(message.header).toEqual({numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:6});
    expect(roles(message)).toEqual([
      {index:0,address:'oMcssxWxgooErb8bsRA4QN34VHhvfeEbdDjrwF6WH45',signer:true,writable:true},
      {index:1,address:'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq',signer:false,writable:true},
      {index:2,address:'BWocXaSJ46XRSnTUA92ffLzLriM7V8tHVLoUnS9HoWQz',signer:false,writable:true},
      {index:3,address:'3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',signer:false,writable:true},
      {index:4,address:'ComputeBudget111111111111111111111111111111',signer:false,writable:false},
      {index:5,address:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',signer:false,writable:false},
      {index:6,address:'R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX',signer:false,writable:false},
      {index:7,address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',signer:false,writable:false},
      {index:8,address:'11111111111111111111111111111111',signer:false,writable:false},
      {index:9,address:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',signer:false,writable:false},
    ]);
  });
});
