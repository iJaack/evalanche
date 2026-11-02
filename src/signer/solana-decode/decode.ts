import type { ParsedSolanaMessage } from '../solana-intent';
import type { Base58, DecodedSolanaAction } from './types';
import { accountRoles } from './accounts';
import { ATA, COMPUTE, SOLANA_HARD_DENIED_PROGRAMS, SYSTEM, TOKEN, TOKEN_2022 } from './constants';
import { decodeComputeBudget } from './compute-budget';
import { decodeSystem } from './system';
import { decodeToken } from './token';
import { decodeAta } from './ata';
import { deny } from './errors';
export function assertProgramNotHardDenied(programId: string, index?: number): void {
  if (SOLANA_HARD_DENIED_PROGRAMS.some(p => p.status === 'verified' && p.programId === programId)) {
    deny('SOL_DENY_PROGRAM_HARD_DENIED', `program ${programId} is hard denied`, index);
  }
}
export function decodeSolanaMessage(message: ParsedSolanaMessage): DecodedSolanaAction[] {
  message.instructions.forEach((ix, index) => assertProgramNotHardDenied(ix.programId, index));
  message.instructions.forEach((ix, index) => {
    if (ix.programId === SYSTEM && ix.data.length >= 4 && Buffer.from(ix.data).readUInt32LE(0) === 4) {
      deny('SOL_DENY_DURABLE_NONCE', 'durable nonce is disabled', index);
    }
  });
  const accounts = accountRoles(message);
  const actions = message.instructions.map((instruction, instructionIndex) => {
    const input = { message, accounts, instruction, instructionIndex };
    switch (instruction.programId) {
      case COMPUTE: return decodeComputeBudget(input);
      case SYSTEM: return decodeSystem(input);
      case TOKEN: case TOKEN_2022: return decodeToken(input);
      case ATA: return decodeAta(input);
      default: return deny('SOL_DENY_PROGRAM_UNKNOWN', `unknown program ${instruction.programId}`, instructionIndex);
    }
  });
  assertComputeBudgetCardinality(actions);
  return actions;
}
export function assertComputeBudgetCardinality(actions: readonly DecodedSolanaAction[]): void {
  if (actions.filter(a => a.kind === 'computeBudget.setComputeUnitLimit').length !== 1
    || actions.filter(a => a.kind === 'computeBudget.setComputeUnitPrice').length !== 1) {
    deny('SOL_DENY_COMPUTE_BUDGET_CARDINALITY', 'exactly one compute limit and price required');
  }
}
export function derivedProgramIds(message: ParsedSolanaMessage, actions: readonly DecodedSolanaAction[]): Base58[] {
  return [...new Set([...message.instructions.map(i => i.programId),
    ...actions.flatMap(a => a.kind === 'ata.create' ? [...a.impliedCpiPrograms] : [])])].sort();
}
