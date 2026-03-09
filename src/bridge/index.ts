/**
 * Bridge module — cross-chain token bridging (Li.Fi) and gas funding (Gas.zip).
 */

export { LiFiClient, NATIVE_TOKEN } from './lifi';
export type { BridgeQuoteParams, BridgeQuote, TransferStatus, TransferStatusParams, LiFiToken, LiFiChain, LiFiTools, LiFiGasPrices, LiFiGasSuggestion, LiFiConnection } from './lifi';
export { GasZipClient } from './gaszip';
export type { GasZipParams, GasZipQuote } from './gaszip';

import type { AgentSigner } from '../wallet/signer';
import { LiFiClient } from './lifi';
import type { BridgeQuoteParams, BridgeQuote, TransferStatus, TransferStatusParams, LiFiToken, LiFiChain, LiFiTools, LiFiGasPrices, LiFiGasSuggestion, LiFiConnection } from './lifi';
import { GasZipClient } from './gaszip';
import type { GasZipParams, GasZipQuote } from './gaszip';

/**
 * Unified bridge client combining Li.Fi (token bridging) and Gas.zip (gas funding).
 */
export class BridgeClient {
  private lifi: LiFiClient;
  private gaszip: GasZipClient;

  constructor(signer: AgentSigner) {
    this.lifi = new LiFiClient(signer);
    this.gaszip = new GasZipClient();
  }

  /**
   * Get the best bridge quote for a cross-chain transfer.
   * @param params - Bridge quote parameters
   * @returns Best available bridge quote
   */
  async bridge(params: BridgeQuoteParams): Promise<BridgeQuote> {
    return this.lifi.getQuote(params);
  }

  /**
   * Get multiple bridge route options.
   * @param params - Bridge quote parameters
   * @returns Array of available bridge quotes sorted by recommendation
   */
  async getBridgeRoutes(params: BridgeQuoteParams): Promise<BridgeQuote[]> {
    return this.lifi.getRoutes(params);
  }

  /**
   * Execute a bridge quote (sends the transaction).
   * @param quote - A previously obtained bridge quote
   * @returns Transaction hash and status
   */
  async executeBridge(quote: BridgeQuote): Promise<{ txHash: string; status: string }> {
    return this.lifi.execute(quote);
  }

  /**
   * Get a Gas.zip quote for funding gas on a destination chain.
   * @param params - Gas funding parameters
   * @returns Gas funding quote
   */
  async getGasQuote(params: GasZipParams): Promise<GasZipQuote> {
    return this.gaszip.getQuote(params);
  }

  /**
   * Fund gas on a destination chain via Gas.zip.
   * @param params - Gas funding parameters
   * @param signer - Agent signer for sending the deposit transaction
   * @returns Transaction hash
   */
  async fundGas(params: GasZipParams, signer: AgentSigner): Promise<{ txHash: string }> {
    return this.gaszip.fundGas(params, signer);
  }

  async checkTransferStatus(params: TransferStatusParams): Promise<TransferStatus> {
    return this.lifi.checkTransferStatus(params);
  }

  async getSwapQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    return this.lifi.getSwapQuote(params);
  }

  async executeSwap(quote: BridgeQuote): Promise<{ txHash: string; status: string }> {
    return this.lifi.execute(quote);
  }

  async getTokens(chainIds: number[]): Promise<Record<string, LiFiToken[]>> {
    return this.lifi.getTokens(chainIds);
  }

  async getToken(chainId: number, address: string): Promise<LiFiToken> {
    return this.lifi.getToken(chainId, address);
  }

  async getChains(chainTypes?: string[]): Promise<LiFiChain[]> {
    return this.lifi.getChains(chainTypes);
  }

  async getTools(): Promise<LiFiTools> {
    return this.lifi.getTools();
  }

  async getGasPrices(): Promise<LiFiGasPrices> {
    return this.lifi.getGasPrices();
  }

  async getGasSuggestion(chainId: number): Promise<LiFiGasSuggestion> {
    return this.lifi.getGasSuggestion(chainId);
  }

  async getConnections(params: { fromChainId: number; toChainId: number; fromToken?: string; toToken?: string }): Promise<LiFiConnection[]> {
    return this.lifi.getConnections(params);
  }
}
