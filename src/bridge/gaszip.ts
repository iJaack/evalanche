/**
 * Gas.zip integration for cheap cross-chain gas funding.
 *
 * Gas.zip provides a simple way to send native gas tokens to a destination chain
 * by depositing on a source chain. Uses the Gas.zip REST API.
 *
 * @see https://docs.gas.zip
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { parseEther } from 'ethers';

const GASZIP_API = 'https://backend.gas.zip/v2';

/** Parameters for a Gas.zip gas funding request */
export interface GasZipParams {
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID */
  toChainId: number;
  /** Recipient address on destination chain */
  toAddress: string;
  /** Amount of native gas to receive on destination (e.g. '0.01' ETH). Optional — Gas.zip has defaults. */
  destinationGasAmount?: string;
}

/** A Gas.zip quote */
export interface GasZipQuote {
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID */
  toChainId: number;
  /** Source token symbol */
  fromToken: string;
  /** Amount to pay on source chain (in native token, human-readable) */
  fromAmount: string;
  /** Gas amount to receive on destination (human-readable) */
  toAmount: string;
  /** Deposit address to send funds to */
  depositAddress: string;
  /** Estimated time in seconds */
  estimatedTime: number;
}

/**
 * Gas.zip client — handles cross-chain gas funding via the Gas.zip API.
 */
export class GasZipClient {
  /**
   * Get a gas funding quote from Gas.zip.
   * @param params - Gas funding parameters
   * @returns Gas funding quote with deposit address
   */
  async getQuote(params: GasZipParams): Promise<GasZipQuote> {
    const searchParams = new URLSearchParams({
      fromChainId: params.fromChainId.toString(),
      toChainId: params.toChainId.toString(),
      toAddress: params.toAddress,
    });

    if (params.destinationGasAmount) {
      searchParams.set('amount', params.destinationGasAmount);
    }

    const res = await fetch(`${GASZIP_API}/quotes?${searchParams}`);

    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Gas.zip quote failed (${res.status}): ${body}`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();

    // Gas.zip may return different response structures — handle both v1 and v2
    const quote = data.quote ?? data;

    return {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromToken: quote.fromToken ?? quote.sourceToken ?? 'ETH',
      fromAmount: quote.fromAmount ?? quote.sourceAmount ?? '0',
      toAmount: quote.toAmount ?? quote.destinationAmount ?? params.destinationGasAmount ?? '0',
      depositAddress: quote.depositAddress ?? quote.deposit ?? quote.to ?? '',
      estimatedTime: quote.estimatedTime ?? quote.eta ?? 60,
    };
  }

  /**
   * Fund gas on a destination chain via Gas.zip.
   * Gets a quote and sends the deposit transaction.
   * @param params - Gas funding parameters
   * @param signer - Agent signer to send the deposit transaction
   * @returns Transaction hash
   */
  async fundGas(params: GasZipParams, signer: AgentSigner): Promise<{ txHash: string }> {
    const quote = await this.getQuote(params);

    if (!quote.depositAddress) {
      throw new EvalancheError(
        'Gas.zip did not return a deposit address',
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    try {
      const value = quote.fromAmount !== '0'
        ? parseEther(quote.fromAmount)
        : parseEther(params.destinationGasAmount ?? '0.001');

      const tx = await signer.sendTransaction({
        to: quote.depositAddress,
        value,
        // Gas.zip deposit transactions are simple value transfers
        // The destination address is encoded in the API response/deposit address
      });

      await tx.wait();

      return { txHash: tx.hash };
    } catch (error) {
      throw new EvalancheError(
        `Gas.zip funding failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
