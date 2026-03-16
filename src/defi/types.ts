import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

// Re-export the DeFi-specific error codes for convenience
export { EvalancheError, EvalancheErrorCode };

// ─── Liquid Staking Types ──────────────────────────────────────────────────────

/** Quote for staking native tokens into a liquid staking derivative */
export interface StakeQuote {
  /** Number of liquid staking shares received */
  shares: string;
  /** Expected output in native token terms */
  expectedOutput: string;
  /** Exchange rate (shares per token) */
  rate: string;
  /** Minimum output after slippage */
  minOutput: string;
  /** Protocol fee, if any */
  fee?: string;
}

/** Quote for unstaking liquid staking shares back to native tokens */
export interface UnstakeQuote {
  /** Amount of native tokens returned */
  avaxOut: string;
  /** Expected output before slippage */
  expectedOutput: string;
  /** Minimum output after slippage */
  minOutput: string;
  /** Current instant pool balance */
  poolBalance: string;
  /** Whether instant redemption is available */
  isInstant: boolean;
  /** Protocol fee, if any */
  fee?: string;
}

/** Configuration for a liquid staking protocol */
export interface StakeConfig {
  contractAddress: string;
  abi?: string[];
  chain: string;
}

// ─── Vault Types ───────────────────────────────────────────────────────────────

/** Quote for a vault deposit or withdrawal */
export interface VaultQuote {
  /** Number of vault shares minted (deposit) or assets returned (withdraw) */
  shares: string;
  /** Expected assets value */
  expectedAssets: string;
  /** Fee on deposit, if any */
  depositFee?: string;
  /** Fee on withdrawal, if any */
  withdrawFee?: string;
}

/** On-chain info about an EIP-4626 vault */
export interface VaultInfo {
  address: string;
  chain: string;
  name: string;
  /** Underlying asset address */
  asset: string;
  /** Annual percentage yield, if known */
  apy?: number;
  /** Total assets held by the vault */
  totalAssets: string;
  /** Whether the vault implements EIP-4626 */
  eip4626: boolean;
}

/** Configuration for an EIP-4626 vault */
export interface VaultConfig {
  contractAddress: string;
  abi?: string[];
  chain: string;
  assetDecimals: number;
}

// ─── Errors ────────────────────────────────────────────────────────────────────

/** DeFi-specific error: instant pool balance too low for redemption */
export class StakePoolInsufficientError extends EvalancheError {
  constructor(message: string, cause?: Error) {
    super(message, EvalancheErrorCode.STAKE_POOL_INSUFFICIENT, cause);
  }
}

/** DeFi-specific error: wallet balance too low for operation */
export class InsufficientBalanceError extends EvalancheError {
  constructor(message: string, cause?: Error) {
    super(message, EvalancheErrorCode.INSUFFICIENT_BALANCE, cause);
  }
}

/** DeFi-specific error: vault operation failed */
export class VaultError extends EvalancheError {
  constructor(message: string, cause?: Error) {
    super(message, EvalancheErrorCode.VAULT_ERROR, cause);
  }
}
