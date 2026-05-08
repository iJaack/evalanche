/**
 * Gas.zip integration for cheap cross-chain gas funding.
 *
 * Gas.zip provides a simple way to send native gas tokens to a destination chain
 * by depositing on a source chain. This implementation sources executable
 * quotes through LI.FI's live GasZip bridge integration so it continues to work
 * even when Gas.zip's standalone REST surface changes.
 *
 * @see https://docs.gas.zip
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
import { formatEther, parseEther } from 'ethers';

const LIFI_API = 'https://li.quest/v1';
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const DEFAULT_DESTINATION_GAS_AMOUNT = '0.001';

/** Parameters for a Gas.zip gas funding request */
export interface GasZipParams {
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID */
  toChainId: number;
  /** Optional sender address for quote generation. Defaults to toAddress. */
  fromAddress?: string;
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
  /** Raw LI.FI quote used for execution */
  rawQuote?: Record<string, unknown>;
}

export interface GasZipAuthorizationRequest {
  to: string;
  valueWei: string;
  data?: string;
  gasLimit?: bigint;
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
    return this.findQuote(params);
  }

  /**
   * Fund gas on a destination chain via Gas.zip.
   * Gets a quote and sends the deposit transaction.
   * @param params - Gas funding parameters
   * @param signer - Agent signer to send the deposit transaction
   * @returns Transaction hash
   */
  async fundGas(
    params: GasZipParams,
    signer: AgentSigner,
    authorize?: (request: GasZipAuthorizationRequest) => Promise<void> | void,
  ): Promise<{ txHash: string }> {
    const quote = await this.findQuote({
      ...params,
      fromAddress: params.fromAddress ?? signer.address,
    });

    if (!quote.depositAddress) {
      throw new EvalancheError(
        'Gas.zip did not return a deposit address',
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    try {
      const txRequest = this.extractTransactionRequest(quote);
      const value = txRequest.value ? BigInt(txRequest.value) : parseEther(quote.fromAmount);
      const to = txRequest.to ?? quote.depositAddress;

      await authorize?.({
        to,
        valueWei: value.toString(),
        data: txRequest.data,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
      });

      const tx = await signer.sendTransaction({
        to,
        data: txRequest.data,
        value,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
        gasPrice: txRequest.gasPrice ? BigInt(txRequest.gasPrice) : undefined,
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

  private async findQuote(params: GasZipParams): Promise<GasZipQuote> {
    const targetToAmountWei = parseEther(params.destinationGasAmount ?? DEFAULT_DESTINATION_GAS_AMOUNT);
    let low = targetToAmountWei;
    let lowQuote = await this.fetchLiFiQuote(params, low);
    if (lowQuote.toAmountWei >= targetToAmountWei) {
      return lowQuote.quote;
    }

    let high = low * 2n;
    let highQuote = await this.fetchLiFiQuote(params, high);
    let attempts = 0;

    while (highQuote.toAmountWei < targetToAmountWei && attempts < 8) {
      low = high;
      lowQuote = highQuote;
      high *= 2n;
      highQuote = await this.fetchLiFiQuote(params, high);
      attempts++;
    }

    if (highQuote.toAmountWei < targetToAmountWei) {
      throw new EvalancheError(
        `Unable to source enough destination gas for ${params.toChainId}`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    let best = highQuote;
    let left = low;
    let right = high;

    for (let iteration = 0; iteration < 10 && right - left > 1n; iteration++) {
      const mid = left + ((right - left) / 2n);
      const midQuote = await this.fetchLiFiQuote(params, mid);
      if (midQuote.toAmountWei >= targetToAmountWei) {
        best = midQuote;
        right = mid;
      } else {
        left = mid + 1n;
      }
    }

    return best.quote;
  }

  private async fetchLiFiQuote(
    params: GasZipParams,
    fromAmountWei: bigint,
  ): Promise<{ quote: GasZipQuote; toAmountWei: bigint }> {
    const fromAddress = params.fromAddress ?? params.toAddress;
    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
      fromToken: NATIVE_TOKEN,
      toToken: NATIVE_TOKEN,
      fromAmount: fromAmountWei.toString(),
      fromAddress,
      toAddress: params.toAddress,
      integrator: 'evalanche',
    });

    const res = await safeFetch(`${LIFI_API}/quote?${searchParams}`, {
      timeoutMs: 15_000,
      maxBytes: 2_000_000,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Gas.zip quote failed (${res.status}): ${body}`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    const data = await res.json() as Record<string, unknown>;
    const tool = String(data.tool ?? '');
    if (!tool.toLowerCase().includes('gaszip')) {
      throw new EvalancheError(
        `Expected a Gas.zip route but received ${tool || 'unknown'}`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }

    const action = (data.action ?? {}) as Record<string, unknown>;
    const estimate = (data.estimate ?? {}) as Record<string, unknown>;
    const transactionRequest = (data.transactionRequest ?? {}) as Record<string, unknown>;
    const toAmount = String(estimate.toAmount ?? '0');

    return {
      quote: {
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromToken: String(action.fromToken && typeof action.fromToken === 'object'
          ? (action.fromToken as Record<string, unknown>).symbol ?? 'ETH'
          : 'ETH'),
        fromAmount: formatEther(fromAmountWei),
        toAmount: formatEther(BigInt(toAmount)),
        depositAddress: String(transactionRequest.to ?? ''),
        estimatedTime: Number(estimate.executionDuration ?? 60),
        rawQuote: data,
      },
      toAmountWei: BigInt(toAmount),
    };
  }

  private extractTransactionRequest(quote: GasZipQuote): Record<string, string> {
    const txRequest = quote.rawQuote?.transactionRequest;
    if (!txRequest || typeof txRequest !== 'object') {
      throw new EvalancheError(
        'Gas.zip quote is missing an executable transaction request',
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }
    return txRequest as Record<string, string>;
  }
}
