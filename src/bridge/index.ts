/**
 * Bridge module — cross-chain token bridging (Li.Fi) and gas funding (Gas.zip).
 */

export { LiFiClient, NATIVE_TOKEN } from './lifi';
export type { BridgeQuoteParams, BridgeQuote } from './lifi';
export { GasZipClient } from './gaszip';
export type { GasZipParams, GasZipQuote } from './gaszip';

import type { AgentSigner } from '../wallet/signer';
import { LiFiClient } from './lifi';
import type { BridgeQuoteParams, BridgeQuote } from './lifi';
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
}
