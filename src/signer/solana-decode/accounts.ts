import type { ParsedSolanaMessage } from '../solana-intent';
import type { DecodeInstructionInput, MessageAccount } from './types';
import { deny } from './errors';
export function accountRoles(message: ParsedSolanaMessage): MessageAccount[] {
  const h = message.header;
  return message.staticAccountKeys.map((address, index) => ({ index, address,
    signer: index < h.numRequiredSignatures,
    writable: index < h.numRequiredSignatures
      ? index < h.numRequiredSignatures - h.numReadonlySignedAccounts
      : index < message.staticAccountKeys.length - h.numReadonlyUnsignedAccounts }));
}
/** Required signer bits and exact writable bits; undefined permits either writable bit. */
export function instructionAccounts(i: DecodeInstructionInput, flags: readonly (readonly [boolean, boolean | undefined])[]): string[] {
  if (i.instruction.accountIndices.length !== flags.length) deny('SOL_DENY_ACCOUNT_COUNT', 'wrong account count', i.instructionIndex);
  return flags.map(([signer, writable], position) => {
    const a = i.accounts[i.instruction.accountIndices[position]];
    if (!a || (signer && !a.signer) || (writable !== undefined && a.writable !== writable)) {
      deny('SOL_DENY_ACCOUNT_FLAGS', `invalid account role ${position}`, i.instructionIndex);
    }
    return a.address;
  });
}
export function instructionData(i: DecodeInstructionInput, length: number): Buffer {
  if (i.instruction.data.length !== length) deny('SOL_DENY_DATA_LENGTH', `expected ${length} bytes`, i.instructionIndex);
  return Buffer.from(i.instruction.data);
}
export function canonicalData(i: DecodeInstructionInput, encoded: Uint8Array): void {
  if (!Buffer.from(i.instruction.data).equals(encoded)) deny('SOL_DENY_NONCANONICAL_DATA', 'instruction does not round trip', i.instructionIndex);
}
export function actionBase(i: DecodeInstructionInput) {
  return { instructionIndex: i.instructionIndex, programId: i.instruction.programId };
}
