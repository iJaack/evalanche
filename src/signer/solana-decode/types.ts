import type { ParsedSolanaMessage } from '../solana-intent';
import type { TOKEN, TOKEN_2022 } from './constants';
export type Base58 = string;
export type TokenProgramId = typeof TOKEN | typeof TOKEN_2022;
export interface MessageAccount { index: number; address: Base58; signer: boolean; writable: boolean }
export interface DecodeInstructionInput {
  message: ParsedSolanaMessage; accounts: readonly MessageAccount[]; instructionIndex: number;
  instruction: ParsedSolanaMessage['instructions'][number];
}
interface ActionBase { instructionIndex: number; programId: Base58 }
export type DecodedSolanaAction = ActionBase & (
  | { kind: 'computeBudget.setComputeUnitLimit'; units: number }
  | { kind: 'computeBudget.setComputeUnitPrice'; microLamports: bigint }
  | { kind: 'system.transfer'; from: Base58; to: Base58; lamports: bigint }
  | { kind: 'token.transferChecked'; tokenProgram: TokenProgramId; source: Base58; mint: Base58;
      destination: Base58; authority: Base58; amount: bigint; decimals: number }
  | { kind: 'token.approveChecked'; tokenProgram: TokenProgramId; source: Base58; mint: Base58;
      delegate: Base58; owner: Base58; amount: bigint; decimals: number }
  | { kind: 'token.revoke'; tokenProgram: TokenProgramId; source: Base58; owner: Base58 }
  | { kind: 'token.closeAccount'; tokenProgram: TokenProgramId; account: Base58; destination: Base58; owner: Base58 }
  | { kind: 'token.syncNative'; tokenProgram: TokenProgramId; account: Base58 }
  | { kind: 'ata.create'; mode: 'create' | 'createIdempotent'; payer: Base58; ata: Base58; wallet: Base58;
      mint: Base58; tokenProgram: TokenProgramId; impliedCpiPrograms: readonly [Base58, TokenProgramId] }
);
export type DecodedSolanaActionJson = {
  [A in DecodedSolanaAction as A['kind']]: { [K in keyof A]: A[K] extends bigint ? string : A[K] }
}[DecodedSolanaAction['kind']];
