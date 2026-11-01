import type { DecodedSolanaAction, DecodeInstructionInput } from './types';
import { TOKEN, TOKEN_2022 } from './constants';
import { actionBase, canonicalData, instructionAccounts, instructionData } from './accounts';
import { deny } from './errors';
export function decodeToken(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: `token.${string}` }> {
  if (i.instruction.programId === TOKEN_2022) deny('SOL_DENY_PROGRAM_NOT_ENABLED', 'Token-2022 is disabled', i.instructionIndex);
  const tag = i.instruction.data[0];
  if (tag === 3 || tag === 4) deny('SOL_DENY_TOKEN_UNCHECKED', 'unchecked token instruction', i.instructionIndex);
  if (tag === 18) deny('SOL_DENY_TOKEN_INIT_OUTSIDE_ATA', 'top-level token initialization', i.instructionIndex);
  if (![5, 9, 12, 13, 17].includes(tag)) deny('SOL_DENY_TOKEN_INSTRUCTION', 'unsupported token instruction', i.instructionIndex);
  const data = instructionData(i, tag === 12 || tag === 13 ? 10 : 1);
  const base = { ...actionBase(i), tokenProgram: TOKEN as typeof TOKEN };
  const encoded = Buffer.alloc(data.length); encoded[0] = tag;
  if (tag === 12 || tag === 13) {
    const [source, mint, target, owner] = instructionAccounts(i, [[false, true], [false, false], [false, tag === 12], [true, undefined]]);
    const amount = data.readBigUInt64LE(1), decimals = data[9];
    encoded.writeBigUInt64LE(amount, 1); encoded[9] = decimals; canonicalData(i, encoded);
    return tag === 12
      ? { ...base, kind: 'token.transferChecked', source, mint, destination: target, authority: owner, amount, decimals }
      : { ...base, kind: 'token.approveChecked', source, mint, delegate: target, owner, amount, decimals };
  }
  canonicalData(i, encoded);
  if (tag === 5) {
    const [source, owner] = instructionAccounts(i, [[false, true], [true, undefined]]);
    return { ...base, kind: 'token.revoke', source, owner };
  }
  if (tag === 9) {
    const [account, destination, owner] = instructionAccounts(i, [[false, true], [false, true], [true, undefined]]);
    return { ...base, kind: 'token.closeAccount', account, destination, owner };
  }
  const [account] = instructionAccounts(i, [[false, true]]);
  return { ...base, kind: 'token.syncNative', account };
}
