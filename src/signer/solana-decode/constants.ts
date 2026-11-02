/** Offline program pins. Unknown prediction-market IDs deliberately remain unenforced. */
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE = 'ComputeBudget111111111111111111111111111111';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const SOLANA_PHASE1_CEILINGS = Object.freeze({ maxComputeUnitLimit: 400000,
  maxComputeUnitPriceMicroLamports: '2500000', maxPriorityFeeLamports: '1000000',
  maxRentLamports: '3000000', maxFeeUsd: '2.00' });
export const SOLANA_HARD_DENIED_PROGRAMS: ReadonlyArray<{
  name: string; programId: string | null; status: 'TO VERIFY' | 'verified'; source?: string;
}> = Object.freeze([
  Object.freeze({ name: 'Drift BET (prediction markets)', programId: null, status: 'TO VERIFY' }),
  Object.freeze({ name: 'Hedgehog Markets', programId: null, status: 'TO VERIFY' }),
]);
