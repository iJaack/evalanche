import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/addresses';
import type { Base58, DecodedSolanaAction, DecodeInstructionInput, TokenProgramId } from './types';
import { ATA, SYSTEM, TOKEN, TOKEN_2022 } from './constants';
import { actionBase, canonicalData, instructionAccounts } from './accounts';
import { deny } from './errors';
export type TreasuryAtaMap = ReadonlyMap<Base58, { ata: Base58; tokenProgram: TokenProgramId }>;
export async function deriveTreasuryAtas(treasury: Base58, mints: Record<Base58, { tokenProgram: TokenProgramId }>): Promise<TreasuryAtaMap> {
  const enc = getAddressEncoder();
  const entries = await Promise.all(Object.entries(mints).map(async ([mint, { tokenProgram }]) => {
    const [ata] = await getProgramDerivedAddress({ programAddress: ATA as Address,
      seeds: [enc.encode(treasury as Address), enc.encode(tokenProgram as Address), enc.encode(mint as Address)] });
    return [mint, { ata, tokenProgram }] as const;
  }));
  return new Map(entries);
}
export function treasuryAtaOwnerOf(map: TreasuryAtaMap, account: Base58): Base58 | undefined {
  for (const [mint, value] of map) if (value.ata === account) return mint;
}
export function decodeAta(i: DecodeInstructionInput): Extract<DecodedSolanaAction, { kind: 'ata.create' }> {
  const indices = i.instruction.accountIndices;
  if (i.accounts[indices[5]]?.address === TOKEN_2022) deny('SOL_DENY_PROGRAM_NOT_ENABLED', 'Token-2022 is disabled', i.instructionIndex);
  const data = i.instruction.data;
  if (data.length > 1) deny('SOL_DENY_DATA_LENGTH', 'ATA data requires zero or one byte', i.instructionIndex);
  if (data.length && data[0] !== 0 && data[0] !== 1) deny('SOL_DENY_ATA_INSTRUCTION', 'unsupported ATA instruction', i.instructionIndex);
  // The wallet can alias the writable treasury payer in the message-wide account table.
  const walletIsPayer = indices[2] === indices[0];
  const [payer, ata, wallet, mint, system, tokenProgram] = instructionAccounts(i,
    [[true, true], [false, true], [false, walletIsPayer ? undefined : false], [false, false], [false, false], [false, false]]);
  if (system !== SYSTEM || tokenProgram !== TOKEN) deny('SOL_DENY_TOKEN_PROGRAM_MISMATCH', 'invalid ATA programs', i.instructionIndex);
  canonicalData(i, data.length ? Uint8Array.of(data[0]) : new Uint8Array());
  return { ...actionBase(i), kind: 'ata.create', mode: data[0] === 1 ? 'createIdempotent' : 'create',
    payer, ata, wallet, mint, tokenProgram, impliedCpiPrograms: [SYSTEM, tokenProgram] };
}
