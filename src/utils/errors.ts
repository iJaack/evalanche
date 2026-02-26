/** Error codes for Evalanche SDK */
export enum EvalancheErrorCode {
  INVALID_CONFIG = 'INVALID_CONFIG',
  WALLET_ERROR = 'WALLET_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  IDENTITY_NOT_FOUND = 'IDENTITY_NOT_FOUND',
  IDENTITY_RESOLUTION_FAILED = 'IDENTITY_RESOLUTION_FAILED',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  CONTRACT_CALL_FAILED = 'CONTRACT_CALL_FAILED',
  X402_PAYMENT_FAILED = 'X402_PAYMENT_FAILED',
  X402_PAYMENT_EXCEEDED = 'X402_PAYMENT_EXCEEDED',
  REPUTATION_SUBMIT_FAILED = 'REPUTATION_SUBMIT_FAILED',
  XCHAIN_ERROR = 'XCHAIN_ERROR',
  PCHAIN_ERROR = 'PCHAIN_ERROR',
  CROSS_CHAIN_ERROR = 'CROSS_CHAIN_ERROR',
  STAKING_ERROR = 'STAKING_ERROR',
  UTXO_ERROR = 'UTXO_ERROR',
}

/** Custom error class for all Evalanche SDK errors */
export class EvalancheError extends Error {
  readonly code: EvalancheErrorCode;
  readonly cause?: Error;

  constructor(message: string, code: EvalancheErrorCode, cause?: Error) {
    super(message);
    this.name = 'EvalancheError';
    this.code = code;
    this.cause = cause;
  }
}
