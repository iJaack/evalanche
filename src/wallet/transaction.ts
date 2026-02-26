import { Contract, parseEther } from 'ethers';
import type { AgentSigner } from './signer';
import type { TransactionIntent, CallIntent, TransactionResult } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Build and send transactions through the agent wallet.
 */
export class TransactionBuilder {
  private readonly wallet: AgentSigner;

  constructor(wallet: AgentSigner) {
    this.wallet = wallet;
  }

  /**
   * Send a simple value transfer or raw data transaction.
   * @param intent - Transaction parameters (to, value in human-readable AVAX, optional data)
   * @returns Transaction hash and receipt
   */
  async send(intent: TransactionIntent): Promise<TransactionResult> {
    try {
      const tx = await this.wallet.sendTransaction({
        to: intent.to,
        value: intent.value ? parseEther(intent.value) : undefined,
        data: intent.data,
        gasLimit: intent.gasLimit,
      });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt is null');
      }
      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Call a contract method (state-changing).
   * @param intent - Contract call parameters
   * @returns Transaction hash and receipt
   */
  async call(intent: CallIntent): Promise<TransactionResult> {
    try {
      const contract = new Contract(intent.contract, intent.abi, this.wallet);
      const tx = await contract[intent.method](...(intent.args ?? []), {
        value: intent.value ? parseEther(intent.value) : undefined,
      });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt is null');
      }
      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Contract call failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
