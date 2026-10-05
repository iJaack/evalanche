import type { AvalancheSigner } from './signer';
import type { AvalancheProvider } from './provider';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * X-Chain (AVM) operations.
 * Handles AVAX transfers and cross-chain exports/imports on the Exchange Chain.
 */
export class XChainOperations {
  private readonly signer: AvalancheSigner;
  private readonly provider: AvalancheProvider;

  constructor(signer: AvalancheSigner, provider: AvalancheProvider) {
    this.signer = signer;
    this.provider = provider;
  }

  /** Get bech32-encoded X-Chain address */
  getAddress(): string {
    return this.signer.getCurrentAddress('X');
  }

  /**
   * Get X-Chain AVAX balance (via UTXOs).
   * @returns Balance in nAVAX as bigint
   */
  async getBalance(): Promise<bigint> {
    try {
      return await this.provider.getXBalance(this.getAddress());
    } catch (error) {
      throw new EvalancheError(
        'Failed to get X-Chain balance',
        EvalancheErrorCode.XCHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Export AVAX from X-Chain to another chain.
   * @param amount - Amount in nAVAX
   * @param destination - Target chain ('P' or 'C')
   * @returns Transaction ID
   */
  async exportTo(amount: bigint, destination: 'P' | 'C'): Promise<string> {
    try {
      return await this.signer.exportX(amount, destination);
    } catch (error) {
      throw new EvalancheError(
        `Failed to export from X-Chain to ${destination}`,
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Import AVAX to X-Chain from another chain.
   * @param sourceChain - Source chain ('P' or 'C')
   * @returns Transaction ID
   */
  async importFrom(sourceChain: 'P' | 'C'): Promise<string> {
    try {
      return await this.signer.importX(sourceChain);
    } catch (error) {
      throw new EvalancheError(
        `Failed to import to X-Chain from ${sourceChain}`,
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
