/** Avalanche chain alias */
export type ChainAlias = 'X' | 'P' | 'C';

/** Result of a cross-chain transfer (export + import) */
export interface TransferResult {
  exportTxId: string;
  importTxId: string;
}

/** Balance info for a single chain */
export interface BalanceInfo {
  chain: ChainAlias;
  balance: string;
  unit: string;
}

/** Balance across all Avalanche chains */
export interface MultiChainBalance {
  C: string;
  X: string;
  P: string;
  total: string;
}

/** Staking delegation info */
export interface StakeInfo {
  staked: string;
  nodeId?: string;
  startTime?: number;
  endTime?: number;
  rewardAddress?: string;
}

/** P-Chain validator info */
export interface ValidatorInfo {
  nodeId: string;
  stakeAmount: string;
  startTime: number;
  endTime: number;
  delegationFee: number;
  uptime: number;
  connected: boolean;
}

/** Min stake amounts from P-Chain */
export interface MinStakeAmounts {
  minValidatorStake: string;
  minDelegatorStake: string;
}
