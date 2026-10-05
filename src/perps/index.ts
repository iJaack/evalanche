/**
 * Perps Module — unified API for perpetual futures trading across venues.
 *
 * Hyperliquid is the supported perpetual venue.
 * Hyperliquid HIP-3 markets are not a separate venue; they are represented as
 * Hyperliquid market metadata with `marketClass: 'hip3'`.
 */

import type { AgentSigner } from '../wallet/signer';
import { HyperliquidClient } from './hyperliquid/client';
import type {
  LimitOrderParams,
  MarketOrderParams,
  PerpMarket,
  PerpPosition,
  PerpVenueName,
} from './types';


export { HyperliquidClient } from './hyperliquid/client';
export type {
  HyperliquidAccountState,
  HyperliquidExecutionResult,
  HyperliquidMarket,
  HyperliquidMarketMetadata,
  HyperliquidOpenOrder,
  HyperliquidOrderStatus,
  HyperliquidPosition,
  HyperliquidTrade,
} from './hyperliquid/types';

export type {
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  PerpVenueName,
  PerpMarketClass,
} from './types';

export interface PerpVenue {
  name: PerpVenueName;
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

export interface PerpClientConfig {
  signer?: AgentSigner;
  address?: string;
}

export class PerpClient {
  private readonly signer?: AgentSigner;
  private readonly address?: string;
  private hyperliquid: HyperliquidClient | null = null;

  constructor(config: PerpClientConfig) {
    this.signer = config.signer;
    this.address = config.address ?? config.signer?.address;
  }

  availableVenues(): PerpVenueName[] {
    const venues: PerpVenueName[] = [];
    if (this.address) venues.push('hyperliquid');
    return venues;
  }

  private getHyperliquid(): HyperliquidClient {
    if (!this.address) {
      throw new Error('Hyperliquid requires a wallet address or signer');
    }
    if (!this.hyperliquid) {
      this.hyperliquid = new HyperliquidClient({
        signer: this.signer,
        address: this.address,
      });
    }
    return this.hyperliquid;
  }

  async connect(venue: PerpVenueName): Promise<void> {
    await this.getClient(venue).connect();
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

  async placeMarketOrder(venue: PerpVenueName, params: MarketOrderParams): Promise<string> {
    return this.getClient(venue).placeMarketOrder(params);
  }

  async placeLimitOrder(venue: PerpVenueName, params: LimitOrderParams): Promise<string> {
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
      case 'hyperliquid':
        return this.getHyperliquid();
      default:
        throw new Error(`Unknown perp venue: ${String(venue)}`);
    }
  }

  hyperliquidClient(): HyperliquidClient {
    return this.getHyperliquid();
  }
}
