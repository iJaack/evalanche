import type { TransactionReceipt } from 'ethers';

/** Intent to send a simple value transfer */
export interface TransactionIntent {
  to: string;
  value?: string;
  data?: string;
  gasLimit?: bigint;
}

/** Intent to call a contract method */
export interface CallIntent {
  contract: string;
  abi: string[];
  method: string;
  args?: unknown[];
  value?: string;
}

/** Result of a sent transaction */
export interface TransactionResult {
  hash: string;
  receipt: TransactionReceipt;
}
