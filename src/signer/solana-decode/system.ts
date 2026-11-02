import type { DecodedSolanaAction, DecodeInstructionInput } from './types';
import { actionBase, canonicalData, instructionAccounts, instructionData } from './accounts';
import { deny } from './errors';
export function decodeSystem(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: 'system.transfer' }> {
  if (i.instruction.data.length < 4) deny('SOL_DENY_DATA_LENGTH', 'System discriminator requires four bytes', i.instructionIndex);
  const tag = Buffer.from(i.instruction.data).readUInt32LE(0);
  if (tag === 4) deny('SOL_DENY_DURABLE_NONCE', 'durable nonce is disabled', i.instructionIndex);
  if (tag !== 2) deny('SOL_DENY_SYSTEM_INSTRUCTION', 'unsupported System instruction', i.instructionIndex);
  const data = instructionData(i, 12);
  const [from, to] = instructionAccounts(i, [[true, true], [false, true]]);
  const lamports = data.readBigUInt64LE(4);
  const encoded = Buffer.alloc(12); encoded.writeUInt32LE(tag); encoded.writeBigUInt64LE(lamports, 4); canonicalData(i, encoded);
  return { ...actionBase(i), kind: 'system.transfer', from, to, lamports };
}
