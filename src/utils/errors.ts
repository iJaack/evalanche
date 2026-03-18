/**
 * Evalanche Error types and codes.
 */

export enum EvalancheErrorCode {
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  INVALID_PARAMS = 'INVALID_PARAMS',
  SIGNER_NOT_FOUND = 'SIGNER_NOT_FOUND',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  CONTRACT_CALL_FAILED = 'CONTRACT_CALL_FAILED',
  CONTRACT_NOT_DEPLOYED = 'CONTRACT_NOT_DEPLOYED',
  QUOTE_FAILED = 'QUOTE_FAILED',
  SWAP_FAILED = 'SWAP_FAILED',
  INSUFFICIENT_LIQUIDITY = 'INSUFFICIENT_LIQUIDITY',
  ARENA_SWAP_FAILED = 'ARENA_SWAP_FAILED',
  ARENA_TOKEN_NOT_FOUND = 'ARENA_TOKEN_NOT_FOUND',
  BRIDGE_FAILED = 'BRIDGE_FAILED',
  BRIDGE_QUOTE_FAILED = 'BRIDGE_QUOTE_FAILED',
  TRANSFER_FAILED = 'TRANSFER_FAILED',
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  RPC_ERROR = 'RPC_ERROR',
  TIMEOUT = 'TIMEOUT',
}

export class EvalancheError extends Error {
  code: EvalancheErrorCode;
  underlying?: Error;

  constructor(message: string, code: EvalancheErrorCode = EvalancheErrorCode.UNKNOWN_ERROR, underlying?: Error) {
    super(message);
    this.name = 'EvalancheError';
    this.code = code;
    this.underlying = underlying;

    if (underlying) {
      this.stack = underlying.stack;
    }
  }

  toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}
