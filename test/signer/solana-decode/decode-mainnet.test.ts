import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/mainnet-messages.json';
import { budget, boundIntent, buildSpec, expectDeny, fromJson, inputAt, intentModule, ix, mod, parse,
  requireFn, toJson, TOKEN, TOKEN_2022 } from './helpers';
import { encodeMessage } from '../solana-message-helpers';
const vectors: any[] = vectorsJson;
const real = vectors.filter(v => v.id.startsWith('R'));
const rewrapped = vectors.flatMap(v => (v.rewraps ?? []).map((recipe: any) => ({ id: v.id, ...recipe })));

describe('recorded mainnet bytes (offline; fetched 2026-11-01T14:14:27.915Z)', () => {
  it('consumes exactly 15 curated originals and 7 rewrap recipes', () => {
    expect(vectors.length).toBeGreaterThan(0); expect(vectors).toHaveLength(15); expect(real).toHaveLength(10);
    expect(rewrapped).toHaveLength(7);
    expect(vectors.map(v => v.id)).toEqual(['R1','R2','R3','R4','R5','R6','R7','R8','R9','R10','L1','L2','L3','L4','V1']);
    for (const v of vectors) {
      expect(v.fetchedAt).toBe('2026-11-01T14:14:27.915Z'); expect(v.rpc).toBe('https://solana-rpc.publicnode.com');
      expect(Buffer.from(v.messageHex, 'hex').toString('hex')).toBe(v.messageHex);
    }
  });
  for (const v of real) {
    it(`${v.id}: exact message outcome and account roles`, () => {
      const decode = requireFn(mod, 'decodeSolanaMessage'); const message = parse(Buffer.from(v.messageHex, 'hex'));
      expect(requireFn(mod, 'accountRoles')(message)).toEqual(v.expectedRoles);
      // Independent header formula checked for every static key, including keys unused by selected instructions.
      const h = message.header;
      expect(v.expectedRoles).toEqual(message.staticAccountKeys.map((address: string, index: number) => ({ index, address,
        signer: index < h.numRequiredSignatures, writable: index < h.numRequiredSignatures
          ? index < h.numRequiredSignatures - h.numReadonlySignedAccounts
          : index < message.staticAccountKeys.length - h.numReadonlyUnsignedAccounts })));
      if (v.expected.deny) expectDeny(() => decode(message), v.expected.deny, v.expected.instructionIndex);
      else {
        const actions = decode(message);
        expect(actions).toEqual(fromJson(v.expected.actions)); expect(toJson(actions)).toEqual(v.expected.actions);
        for (const a of actions) for (const field of ['amount', 'lamports', 'microLamports']) {
          if (field in a) expect(typeof a[field]).toBe('bigint');
        }
      }
    });
    for (const p of v.instructionPositives ?? []) it(`${v.id} instruction ${p.index}: ${p.decoder} exact fields`, () => {
      const decode = requireFn(mod, p.decoder); const message = parse(Buffer.from(v.messageHex, 'hex'));
      expect(decode(inputAt(message, p.index))).toEqual(fromJson(p.expected));
    });
  }
  for (const v of real.slice(0,3)) for (const index of [0,1]) it(`${v.id} instruction ${index}: real ComputeBudget exact fields`, () => {
    const decode = requireFn(mod, 'decodeComputeBudget'); const message = parse(Buffer.from(v.messageHex, 'hex'));
    expect(decode(inputAt(message, index))).toEqual(fromJson(v.expected.actions[index]));
  });
  for (const recipe of rewrapped) it(`${recipe.id} source ${recipe.sourceInstructionIndices}: byte-preserving v0 rewrap`, () => {
    const decode = requireFn(mod, 'decodeSolanaMessage');
    expect(recipe.provenance).toBe('mainnet-rewrapped');
    const instructions = recipe.instructions.map((i: any) => ix(i.program, Buffer.from(i.dataHex, 'hex'),
      i.accounts.map((a: any) => ({ ...a, signer: a.address === recipe.payer }))));
    const rebuilt = encodeMessage(buildSpec([...budget(), ...instructions], recipe.payer));
    expect(rebuilt.toString('hex')).toBe(recipe.messageHex);
    const message = parse(rebuilt);
    expect(Buffer.from(message.instructions[2].data).toString('hex')).toBe(recipe.instructions[0].dataHex);
    if (recipe.expected.deny) expectDeny(() => decode(message), recipe.expected.deny, recipe.expected.instructionIndex);
    else {
      expect(decode(message)).toEqual(fromJson(recipe.expected.actions));
      expect(requireFn(mod, 'decodeToken')(inputAt(message, 2))).toEqual(fromJson(recipe.expected.actions[2]));
    }
  });
  for (const v of vectors.filter(v => !v.id.startsWith('R'))) it(`${v.id}: original legacy/ALT parser rejection`, () => {
    expect(() => parse(Buffer.from(v.messageHex, 'hex'))).toThrow(v.id === 'V1' ? /ALT|lookup|address table/i : /v0/i);
  });
  it('R9 Token-2022 closeAccount denies before structural decoding at index 6', () => {
    const decode = requireFn(mod, 'decodeToken'); const message = parse(Buffer.from(real[8].messageHex, 'hex'));
    expect(message.instructions[5].programId).toBe(TOKEN); expect(message.instructions[6].programId).toBe(TOKEN_2022);
    expectDeny(() => decode(inputAt(message, 6)), 'SOL_DENY_PROGRAM_NOT_ENABLED', 6);
  });
  it('R10 Token-2022 InitializeAccount3 denies at instruction level (nonce still wins for the message)', () => {
    const decode = requireFn(mod, 'decodeToken'); const message = parse(Buffer.from(real[9].messageHex, 'hex'));
    expectDeny(() => decode(inputAt(message, 6)), 'SOL_DENY_PROGRAM_NOT_ENABLED', 6);
  });
  it('PR2 unchanged binding API now detects R4 AdvanceNonceAccount from wire bytes', () => {
    const message = Buffer.from(real[3].messageHex, 'hex'); const intent = boundIntent(message);
    expect(() => requireFn(intentModule, 'assertSolanaMessageMatchesIntent')(intent)).toThrow(/durable nonce|SOL_DENY_DURABLE_NONCE/i);
  });
});
