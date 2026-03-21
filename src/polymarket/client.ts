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
import { safeFetch } from '../utils/safe-fetch';

export const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
export const POLYMARKET_GAMMA_HOST = 'https://gamma-api.polymarket.com';

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

interface GammaMarketRecord extends Record<string, unknown> {
  conditionId?: string;
  question?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  volume?: string | number;
}

function polymarketHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': 'evalanche/1.6.0 (+https://github.com/ijaack/evalanche)',
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeMarketRecord(record: GammaMarketRecord): PolymarketMarket {
  const outcomes = toStringArray(record.outcomes);
  const prices = toStringArray(record.outcomePrices).map((value) => toNumber(value));
  const tokenIds = toStringArray(record.clobTokenIds);
  const conditionId = String(record.conditionId ?? '');

  const tokens: PolymarketToken[] = outcomes.map((outcome, index) => ({
    tokenId: tokenIds[index] ?? '',
    conditionId,
    outcome,
    price: prices[index],
    volume: toNumber(record.volume),
  }));

  return {
    conditionId,
    question: String(record.question ?? ''),
    description: typeof record.description === 'string' ? record.description : undefined,
    startDate: typeof record.startDate === 'string' ? record.startDate : undefined,
    endDate: typeof record.endDate === 'string' ? record.endDate : undefined,
    tokens,
  };
}

function normalizeClobMarket(record: Record<string, unknown>): PolymarketMarket {
  const conditionId = String(record.condition_id ?? record.conditionId ?? '');
  const tokensRaw = Array.isArray(record.tokens) ? record.tokens : [];
  const tokens: PolymarketToken[] = tokensRaw.map((token) => {
    const item = (token ?? {}) as Record<string, unknown>;
    return {
      tokenId: String(item.token_id ?? item.tokenId ?? ''),
      conditionId,
      outcome: String(item.outcome ?? ''),
      price: toNumber(item.price),
      volume: toNumber(item.volume),
    };
  });

  return {
    conditionId,
    question: String(record.question ?? ''),
    description: typeof record.description === 'string' ? record.description : undefined,
    startDate: typeof record.start_date_iso === 'string' ? String(record.start_date_iso) : undefined,
    endDate: typeof record.end_date_iso === 'string' ? String(record.end_date_iso) : undefined,
    tokens,
  };
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
    const limit = Math.min(options?.limit ?? 100, 500);
    const url = new URL('/markets', POLYMARKET_GAMMA_HOST);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', options?.cursor ? String(Number(options.cursor) || 0) : '0');
    if (options?.closed !== undefined) url.searchParams.set('closed', String(options.closed));
    if (options?.closed === false) url.searchParams.set('active', 'true');

    try {
      const response = await safeFetch(url.toString(), {
        headers: polymarketHeaders(),
        timeoutMs: 12_000,
        maxBytes: 2_000_000,
      });
      if (!response.ok) {
        throw new EvalancheError(
          `Gamma markets request failed with status ${response.status}`,
          EvalancheErrorCode.CONTRACT_CALL_FAILED,
        );
      }

      const records = await response.json() as GammaMarketRecord[];
      return records.map(normalizeMarketRecord);
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch markets: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }


  async searchMarkets(query: string, limit = 10): Promise<PolymarketMarket[]> {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const pageSize = 100;
    const maxPages = 10;
    const matches: PolymarketMarket[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages && matches.length < limit; page++) {
      const markets = await this.getMarkets({
        limit: pageSize,
        closed: false,
        cursor: String(page * pageSize),
      });

      if (markets.length === 0) break;

      for (const market of markets) {
        const haystack = `${market.question} ${market.description ?? ''}`.toLowerCase();
        if (haystack.includes(q) && !seen.has(market.conditionId)) {
          matches.push(market);
          seen.add(market.conditionId);
        }
        if (matches.length >= limit) break;
      }

      if (markets.length < pageSize) break;
    }

    return matches.slice(0, limit);
  }

  async getMarket(conditionId: string): Promise<PolymarketMarket | null> {
    const url = new URL(`/markets/${conditionId}`, POLYMARKET_CLOB_HOST);

    try {
      const response = await safeFetch(url.toString(), {
        headers: polymarketHeaders(),
        timeoutMs: 12_000,
        maxBytes: 1_500_000,
      });

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new EvalancheError(
          `CLOB market request failed with status ${response.status}`,
          EvalancheErrorCode.CONTRACT_CALL_FAILED,
        );
      }

      const record = await response.json() as Record<string, unknown>;
      return normalizeClobMarket(record);
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch market: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getMarketTokens(conditionId: string): Promise<PolymarketToken[]> {
    const market = await this.getMarket(conditionId);
    return market?.tokens || [];
  }

  async getTokenPrice(tokenId: string): Promise<number> {
    try {
      const orderBook = await this.getOrderBook(tokenId);
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
    const mapOrders = (side: unknown): PolymarketOrder[] =>
      Array.isArray(side)
        ? side.map((entry) => {
          const item = (entry ?? {}) as Record<string, unknown>;
          return {
            price: toNumber(item.price) ?? 0,
            size: toNumber(item.size) ?? 0,
            orderID: String(item.order_id ?? item.orderID ?? ''),
          };
        })
        : [];

    if (this.clobClient && typeof this.clobClient.getOrderBook === 'function') {
      const book = await this.clobClient.getOrderBook(tokenId);
      return {
        bids: mapOrders(book?.bids),
        asks: mapOrders(book?.asks),
      };
    }

    const url = new URL('/book', POLYMARKET_CLOB_HOST);
    url.searchParams.set('token_id', tokenId);

    try {
      const response = await safeFetch(url.toString(), {
        headers: polymarketHeaders(),
        timeoutMs: 12_000,
        maxBytes: 1_500_000,
      });

      if (!response.ok) {
        throw new EvalancheError(
          `CLOB order book request failed with status ${response.status}`,
          EvalancheErrorCode.CONTRACT_CALL_FAILED,
        );
      }

      const book = await response.json() as Record<string, unknown>;
      return {
        bids: mapOrders(book.bids),
        asks: mapOrders(book.asks),
      };
    } catch (error) {
      throw new EvalancheError(
        `Failed to get order book: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }


  async getOrderbook(tokenId: string): Promise<PolymarketOrderBook> {
    return this.getOrderBook(tokenId);
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
      const orderBook = await this.getOrderBook(tokenId);
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
