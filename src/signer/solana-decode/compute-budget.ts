import type { DecodedSolanaAction, DecodeInstructionInput } from './types';
import { actionBase, canonicalData, instructionAccounts, instructionData } from './accounts';
import { deny } from './errors';
export function decodeComputeBudget(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: `computeBudget.${string}` }> {
  const tag = i.instruction.data[0];
  if (tag !== 2 && tag !== 3) deny('SOL_DENY_COMPUTE_BUDGET_INSTRUCTION', 'unsupported compute budget instruction', i.instructionIndex);
  const data = instructionData(i, tag === 2 ? 5 : 9);
  instructionAccounts(i, []);
  const encoded = Buffer.alloc(data.length); encoded[0] = tag;
  if (tag === 2) {
    const units = data.readUInt32LE(1); encoded.writeUInt32LE(units, 1); canonicalData(i, encoded);
    return { ...actionBase(i), kind: 'computeBudget.setComputeUnitLimit', units };
  }
  const microLamports = data.readBigUInt64LE(1); encoded.writeBigUInt64LE(microLamports, 1); canonicalData(i, encoded);
  return { ...actionBase(i), kind: 'computeBudget.setComputeUnitPrice', microLamports };
}
