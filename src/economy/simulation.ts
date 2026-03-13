import type { JsonRpcProvider } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { PendingTransaction } from './types';

/** Result of a transaction simulation */
export interface SimulationResult {
  /** Whether the transaction would succeed */
  success: boolean;
  /** Estimated gas units if successful */
  gasEstimate?: string;
  /** Decoded revert reason if failed */
  revertReason?: string;
  /** Raw return data from eth_call (hex) */
  returnData?: string;
}

/**
 * Simulate a transaction via eth_call without broadcasting it.
 *
 * This performs a dry-run on the node: the transaction is executed in a
 * temporary sandbox and the result is returned without spending any gas.
 *
 * @param provider - ethers JsonRpcProvider connected to the target chain
 * @param tx - The pending transaction to simulate
 * @returns SimulationResult with success/failure, gas estimate, and revert reason
 */
export async function simulateTransaction(
  provider: JsonRpcProvider,
  tx: PendingTransaction,
): Promise<SimulationResult> {
  const callParams = {
    to: tx.to,
    value: tx.value ? BigInt(tx.value) : undefined,
    data: tx.data,
    gasLimit: tx.gasLimit,
  };

  try {
    // eth_call: execute without mining — returns raw output or throws on revert
    const returnData = await provider.call(callParams);

    // If eth_call succeeds, estimate gas for the real transaction
    let gasEstimate: string | undefined;
    try {
      const estimate = await provider.estimateGas(callParams);
      gasEstimate = estimate.toString();
    } catch {
      // Gas estimation can fail even if eth_call succeeds (e.g. state-dependent).
      // The simulation still counts as successful.
    }

    return {
      success: true,
      gasEstimate,
      returnData,
    };
  } catch (error) {
    // Extract revert reason from the error
    const revertReason = decodeRevertReason(error);

    return {
      success: false,
      revertReason,
    };
  }
}

/**
 * Extract a human-readable revert reason from an ethers call error.
 *
 * Ethers v6 wraps revert data in various error types. This function
 * handles the common shapes: CALL_EXCEPTION, plain message, and
 * raw revert hex data.
 */
function decodeRevertReason(error: unknown): string {
  if (error instanceof Error) {
    // ethers v6 CALL_EXCEPTION includes a `reason` field
    const anyErr = error as unknown as Record<string, unknown>;
    if (typeof anyErr.reason === 'string') {
      return anyErr.reason;
    }
    // Some errors include revert data as hex
    if (typeof anyErr.data === 'string' && anyErr.data.startsWith('0x')) {
      return tryDecodeErrorData(anyErr.data) ?? `raw revert data: ${anyErr.data}`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * Try to decode standard Solidity Error(string) from raw revert data.
 * Selector: 0x08c379a0
 */
function tryDecodeErrorData(data: string): string | null {
  // Error(string) selector = 0x08c379a0
  if (data.startsWith('0x08c379a0') && data.length >= 138) {
    try {
      // Skip selector (4 bytes = 8 hex chars + 2 for "0x")
      // Next 32 bytes = offset, next 32 bytes = length, then the string
      const hex = data.slice(10); // remove "0x08c379a0"
      const lengthHex = hex.slice(64, 128);
      const length = parseInt(lengthHex, 16);
      const strHex = hex.slice(128, 128 + length * 2);
      const bytes = Buffer.from(strHex, 'hex');
      return bytes.toString('utf-8');
    } catch {
      return null;
    }
  }
  return null;
}
