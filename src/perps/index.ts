/**
 * Perps Module — unified API for perpetual futures trading across different venues.
 *
 * Provides a single entry point for:
 *   - dYdX (currently the only supported venue)
 *   - Future: other perpetual futures exchanges
 */

import type { AgentSigner } from '../wallet/signer';
import { DydxClient } from './dydx/client';

export { DydxClient } from './dydx/client';
export { DYDX_MARKETS, market } from './dydx/markets';
export type { DydxMarketRef } from './dydx/markets';
export type {
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  DydxSubaccount,
} from './dydx/types';

export interface PerpVenue {
  name: string;
  connect(): Promise<void>;
  getMarkets(): Promise<PerpMarket[]>;
  hasMarket(ticker: string): Promise<boolean>;
  getPositions(): Promise<PerpPosition[]>;
  getBalance(): Promise<string>;
  placeMarketOrder(params: MarketOrderParams): Promise<string>;
  placeLimitOrder(params: LimitOrderParams): Promise<string>;
  cancelOrder(orderId: string): Promise<void>;
  closePosition(market: string): Promise<string>;
}

export type PerpVenueName = 'dydx';

export class PerpClient {
  private readonly signer: AgentSigner;
  private dydx: DydxClient | null = null;

  constructor(signer: AgentSigner) {
    this.signer = signer;
  }

  private getDydx(): DydxClient {
    if (!this.dydx) {
      this.dydx = new DydxClient(this.signer);
    }
    return this.dydx;
  }

  async connect(venue: PerpVenueName): Promise<void> {
    const client = this.getClient(venue);
    if ('connect' in client && typeof client.connect === 'function') {
      await client.connect();
    }
  }

  async getMarkets(venue: PerpVenueName): Promise<PerpMarket[]> {
    return this.getClient(venue).getMarkets();
  }

  async hasMarket(venue: PerpVenueName, ticker: string): Promise<boolean> {
    return this.getClient(venue).hasMarket(ticker);
  }

  async getPositions(venue: PerpVenueName): Promise<PerpPosition[]> {
    return this.getClient(venue).getPositions();
  }

  async getBalance(venue: PerpVenueName): Promise<string> {
    return this.getClient(venue).getBalance();
  }

  async placeMarketOrder(
    venue: PerpVenueName,
    params: MarketOrderParams,
  ): Promise<string> {
    return this.getClient(venue).placeMarketOrder(params);
  }

  async placeLimitOrder(
    venue: PerpVenueName,
    params: LimitOrderParams,
  ): Promise<string> {
    return this.getClient(venue).placeLimitOrder(params);
  }

  async cancelOrder(venue: PerpVenueName, orderId: string): Promise<void> {
    return this.getClient(venue).cancelOrder(orderId);
  }

  async closePosition(venue: PerpVenueName, market: string): Promise<string> {
    return this.getClient(venue).closePosition(market);
  }

  getClient(venue: PerpVenueName): PerpVenue {
    switch (venue) {
      case 'dydx':
        return this.getDydx();
      default:
        throw new Error(`Unknown perp venue: ${venue}`);
    }
  }

  dydxClient(): DydxClient {
    return this.getDydx();
  }
}
