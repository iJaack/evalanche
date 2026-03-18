/**
 * Polymarket Module — prediction market integration.
 *
 * Provides access to Polymarket's CLOB (Central Limit Order Book) for trading
 * conditional tokens (prediction market outcomes).
 *
 * Official SDK: @polymarket/clob-client
 * API docs: https://docs.polymarket.com
 *
 * Supported chains:
 *   - Polygon: chainId 137
 *   - Arbitrum: chainId 42161
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';

export type PolymarketChain = 137 | 42161;

export enum PolymarketSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export interface PolymarketMarket {
  conditionId: string;
  question: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  tokens: PolymarketToken[];
}

export interface PolymarketToken {
  tokenId: string;
  conditionId: string;
  outcome: string;
  price?: number;
  volume?: number;
}

export interface PolymarketOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side: PolymarketSide;
}

export interface PolymarketOrderResult {
  orderID: string;
  status: string;
  averageFillPrice?: number;
}

export interface PolymarketOrderBook {
  bids: PolymarketOrder[];
  asks: PolymarketOrder[];
}

export interface PolymarketOrder {
  price: number;
  size: number;
  orderID: string;
}

export class PolymarketClient {
  private host: string;
  private chainId: PolymarketChain;
  private signer: AgentSigner;
  private apiCreds?: { key: string; secret: string };
  private clobClient: any = null;

  constructor(
    signer: AgentSigner,
    chainId: PolymarketChain = 137,
    host: string = POLYMARKET_CLOB_HOST,
    apiCreds?: { key: string; secret: string },
  ) {
    this.signer = signer;
    this.chainId = chainId;
    this.host = host;
    this.apiCreds = apiCreds;
  }

  private async getClient(): Promise<any> {
    if (this.clobClient) return this.clobClient;

    try {
      const { ClobClient } = await import('@polymarket/clob-client');
      this.clobClient = new ClobClient(
        this.host,
        this.chainId,
        this.signer,
        this.apiCreds,
      );
      return this.clobClient;
    } catch (error) {
      throw new EvalancheError(
        `Failed to load Polymarket SDK. Install with: npm install @polymarket/clob-client ethers@5`,
        EvalancheErrorCode.NOT_IMPLEMENTED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getMarkets(options?: { limit?: number; closed?: boolean; cursor?: string }): Promise<PolymarketMarket[]> {
    try {
      const client = await this.getClient();
      const result = await client.getMarkets(options);
      return result || [];
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch markets: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getMarket(conditionId: string): Promise<PolymarketMarket | null> {
    try {
      const client = await this.getClient();
      return await client.getMarket(conditionId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch market: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getMarketTokens(conditionId: string): Promise<PolymarketToken[]> {
    try {
      const client = await this.getClient();
      const market = await client.getMarket(conditionId);
      return market?.tokens || [];
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch market tokens: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getTokenPrice(tokenId: string): Promise<number> {
    try {
      const client = await this.getClient();
      const orderBook = await client.getOrderBook(tokenId);
      if (orderBook?.bids?.length > 0) {
        return orderBook.bids[0].price;
      }
      return 0;
    } catch (error) {
      throw new EvalancheError(
        `Failed to get token price: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
    try {
      const client = await this.getClient();
      return await client.getOrderBook(tokenId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to get order book: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async placeOrder(params: PolymarketOrderParams): Promise<PolymarketOrderResult> {
    try {
      const client = await this.getClient();
      const { Side } = await import('@polymarket/clob-client');

      const order = await client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          size: params.size,
          side: params.side === PolymarketSide.BUY ? Side.BUY : Side.SELL,
        },
        { tickSize: '0.01', negRisk: false },
      );

      return {
        orderID: order.orderID || '',
        status: order.status || 'OPEN',
        averageFillPrice: order.averageFillPrice,
      };
    } catch (error) {
      throw new EvalancheError(
        `Failed to place order: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      const client = await this.getClient();
      await client.cancelOrder(orderId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to cancel order: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getOrder(orderId: string): Promise<any> {
    try {
      const client = await this.getClient();
      return await client.getOrder(orderId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to get order: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getOpenOrders(tokenId?: string): Promise<any[]> {
    try {
      const client = await this.getClient();
      return await client.getOpenOrders(tokenId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to get open orders: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getPositions(): Promise<any[]> {
    try {
      const client = await this.getClient();
      return await client.getPositions();
    } catch (error) {
      throw new EvalancheError(
        `Failed to get positions: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getBalances(): Promise<any> {
    try {
      const client = await this.getClient();
      return await client.getBalances();
    } catch (error) {
      throw new EvalancheError(
        `Failed to get balances: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getTradeHistory(tokenId?: string): Promise<any[]> {
    try {
      const client = await this.getClient();
      return await client.getTrades(tokenId);
    } catch (error) {
      throw new EvalancheError(
        `Failed to get trade history: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async estimateFillPrice(tokenId: string, side: PolymarketSide, size: number): Promise<number> {
    try {
      const client = await this.getClient();
      const orderBook = await client.getOrderBook(tokenId);
      const orders = side === PolymarketSide.BUY ? orderBook.asks : orderBook.bids;
      let remaining = size;
      let totalCost = 0;

      for (const order of orders) {
        if (remaining <= 0) break;
        const fillSize = Math.min(remaining, order.size);
        totalCost += fillSize * order.price;
        remaining -= fillSize;
      }

      return remaining > 0 ? 0 : totalCost / size;
    } catch (error) {
      throw new EvalancheError(
        `Failed to estimate fill price: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
