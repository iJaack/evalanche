/**
 * Polymarket Module — prediction market integration.
 *
 * Provides access to Polymarket's CLOB (Central Limit Order Book) for trading
 * conditional tokens (prediction market outcomes).
 *
 * Reads:
 * - market search and lookup
 * - outcome token discovery
 * - order book and price inspection
 * - balances, positions, open orders, and trade history
 *
 * Writes:
 * - direct BUY and SELL orders through `placeOrder()`
 * - market sells through `placeMarketSellOrder()`
 * - bridge withdrawals of Polygon USDC.e via `withdrawUsdc()`
 * - winning-share redemption through the CTF `redeemPositions()` path
 *
 * Official CLI: Polymarket/polymarket-cli
 * API docs: https://docs.polymarket.com
 *
 * Supported chains:
 *   - Polygon: chainId 137
 *   - Arbitrum: chainId 42161
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
import { PolymarketCli } from './cli';

export const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
export const POLYMARKET_GAMMA_HOST = 'https://gamma-api.polymarket.com';
export const POLYMARKET_BRIDGE_HOST = 'https://bridge.polymarket.com';
export const POLYMARKET_USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const POLYMARKET_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const POLYMARKET_PARENT_COLLECTION_ID = `0x${'0'.repeat(64)}`;
const POLYMARKET_REDEEM_INDEX_SETS = [1n, 2n] as const;

const ERC20_BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const CTF_REDEEM_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'payoutDenominator',
    type: 'function',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'payoutNumerators',
    type: 'function',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'balanceOfBatch',
    type: 'function',
    inputs: [
      { name: 'accounts', type: 'address[]' },
      { name: 'ids', type: 'uint256[]' },
    ],
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'view',
  },
] as const;

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
  winner?: boolean;
}

export interface PolymarketOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side: PolymarketSide;
  tickSize?: string;
  negRisk?: boolean;
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

function sortPolymarketOrders(orders: PolymarketOrder[], side: 'bid' | 'ask'): PolymarketOrder[] {
  return [...orders].sort((a, b) => {
    const aValid = Number.isFinite(a.price) && a.price > 0;
    const bValid = Number.isFinite(b.price) && b.price > 0;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return side === 'bid' ? b.price - a.price : a.price - b.price;
  });
}

function normalizePolymarketOrderBook(orderBook: PolymarketOrderBook): PolymarketOrderBook {
  return {
    bids: sortPolymarketOrders(orderBook.bids, 'bid'),
    asks: sortPolymarketOrders(orderBook.asks, 'ask'),
  };
}

export interface PolymarketRedemptionResult {
  conditionId: string;
  txHash: string;
  receiptStatus: 'success' | 'reverted';
  blockNumber: string;
  collateralToken: string;
  ctfContract: string;
  parentCollectionId: string;
  indexSets: string[];
  marketQuestion?: string;
  tokenIds: string[];
  winningOutcomes: string[];
  payoutVector: string[];
  usdcBefore: { raw: string; formatted: string };
  usdcAfter: { raw: string; formatted: string };
  usdcDelta: { raw: string; formatted: string };
  tokenBalancesBefore: Array<{ tokenId: string; outcome?: string; raw: string }>;
  tokenBalancesAfter: Array<{ tokenId: string; outcome?: string; raw: string }>;
}

export interface PolymarketBridgeQuote {
  quoteId: string;
  estCheckoutTimeMs?: number;
  estInputUsd?: number;
  estOutputUsd?: number;
  estToTokenBaseUnit?: string;
  estFeeBreakdown?: Record<string, unknown>;
}

export interface PolymarketBridgeAddresses {
  evm?: string;
  svm?: string;
  btc?: string;
  tvm?: string;
}

export interface PolymarketBridgeStatusTransaction {
  fromChainId?: string;
  fromTokenAddress?: string;
  fromAmountBaseUnit?: string;
  toChainId?: string;
  toTokenAddress?: string;
  txHash?: string;
  createdTimeMs?: number;
  status?: string;
}

export interface PolymarketWithdrawalResult {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  recipientAddr: string;
  quote: PolymarketBridgeQuote;
  bridgeAddresses: PolymarketBridgeAddresses;
  bridgeAddress: string;
  bridgeNote?: string;
  txHash: string;
  receiptStatus: 'success' | 'reverted';
  blockNumber: string;
  amountBaseUnit: string;
  amountUSDC: string;
  usdcBefore: { raw: string; formatted: string };
  usdcAfter: { raw: string; formatted: string };
  usdcDelta: { raw: string; formatted: string };
  bridgeStatus: { transactions: PolymarketBridgeStatusTransaction[] } | null;
  bridgeTransaction: PolymarketBridgeStatusTransaction | null;
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

interface ClobMarketRecord extends Record<string, unknown> {
  condition_id?: string;
  conditionId?: string;
  question?: string;
  description?: string;
  start_date_iso?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  tokens?: unknown[];
}

interface BridgeQuoteRecord extends Record<string, unknown> {
  quoteId?: string;
  estCheckoutTimeMs?: number | string;
  estInputUsd?: number | string;
  estOutputUsd?: number | string;
  estToTokenBaseUnit?: string;
  estFeeBreakdown?: Record<string, unknown>;
}

interface BridgeAddressRecord extends Record<string, unknown> {
  evm?: string;
  svm?: string;
  btc?: string;
  tvm?: string;
}

interface BridgeWithdrawalAddressRecord extends Record<string, unknown> {
  address?: BridgeAddressRecord;
  note?: string;
}

interface BridgeStatusRecord extends Record<string, unknown> {
  transactions?: unknown[];
}

function polymarketHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': 'evalanche/1.6.0 (+https://github.com/ijaack/evalanche)',
  };
}

function normalizeBridgeQuote(record: BridgeQuoteRecord): PolymarketBridgeQuote {
  return {
    quoteId: String(record.quoteId ?? ''),
    estCheckoutTimeMs: toNumber(record.estCheckoutTimeMs),
    estInputUsd: toNumber(record.estInputUsd),
    estOutputUsd: toNumber(record.estOutputUsd),
    estToTokenBaseUnit: typeof record.estToTokenBaseUnit === 'string' ? record.estToTokenBaseUnit : undefined,
    estFeeBreakdown: typeof record.estFeeBreakdown === 'object' && record.estFeeBreakdown
      ? record.estFeeBreakdown
      : undefined,
  };
}

function normalizeBridgeAddresses(record: BridgeAddressRecord | undefined): PolymarketBridgeAddresses {
  return {
    evm: typeof record?.evm === 'string' ? record.evm : undefined,
    svm: typeof record?.svm === 'string' ? record.svm : undefined,
    btc: typeof record?.btc === 'string' ? record.btc : undefined,
    tvm: typeof record?.tvm === 'string' ? record.tvm : undefined,
  };
}

function normalizeBridgeStatusTransaction(record: unknown): PolymarketBridgeStatusTransaction {
  const tx = (record ?? {}) as Record<string, unknown>;
  return {
    fromChainId: typeof tx.fromChainId === 'string' ? tx.fromChainId : undefined,
    fromTokenAddress: typeof tx.fromTokenAddress === 'string' ? tx.fromTokenAddress : undefined,
    fromAmountBaseUnit: typeof tx.fromAmountBaseUnit === 'string' ? tx.fromAmountBaseUnit : undefined,
    toChainId: typeof tx.toChainId === 'string' ? tx.toChainId : undefined,
    toTokenAddress: typeof tx.toTokenAddress === 'string' ? tx.toTokenAddress : undefined,
    txHash: typeof tx.txHash === 'string' ? tx.txHash : undefined,
    createdTimeMs: toNumber(tx.createdTimeMs),
    status: typeof tx.status === 'string' ? tx.status : undefined,
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

function normalizeClobMarket(record: ClobMarketRecord): PolymarketMarket {
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
      winner: typeof item.winner === 'boolean' ? item.winner : undefined,
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

function hasSearchableMarketIdentity(market: PolymarketMarket): boolean {
  return market.conditionId.trim().length > 0 && market.question.trim().length > 0;
}

function hasTradeableTokens(market: PolymarketMarket): boolean {
  return market.tokens.some((token) => token.tokenId.trim().length > 0 && token.outcome.trim().length > 0);
}

function isFutureOrUnknown(dateValue: string | undefined): boolean {
  if (!dateValue) return true;
  const timestamp = Date.parse(dateValue);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp > Date.now();
}

function isSearchableGammaMarket(record: GammaMarketRecord): boolean {
  return hasSearchableMarketIdentity(normalizeMarketRecord(record)) && isFutureOrUnknown(
    typeof record.endDate === 'string' ? record.endDate : undefined,
  );
}

function isLiveClobMarket(record: ClobMarketRecord): boolean {
  if (record.closed === true || record.archived === true) return false;
  if (record.active === false || record.accepting_orders === false) return false;

  const market = normalizeClobMarket(record);
  return hasSearchableMarketIdentity(market) && hasTradeableTokens(market) && isFutureOrUnknown(market.endDate);
}

export class PolymarketClient {
  private host: string;
  private chainId: PolymarketChain;
  private signer: AgentSigner;
  private apiCreds?: { key: string; secret: string };
  private clobClient: any = null;
  private cli: PolymarketCli;

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
    this.cli = new PolymarketCli({ privateKey: this.getOptionalPrivateKey() });
  }

  private requireConditionId(conditionId: string): `0x${string}` {
    const value = String(conditionId ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new EvalancheError(
        `Invalid conditionId: expected 32-byte hex string, got ${conditionId}`,
        EvalancheErrorCode.INVALID_PARAMS,
      );
    }
    return value as `0x${string}`;
  }

  private requirePrivateKey(): `0x${string}` {
    const raw = typeof this.signer === 'object' && this.signer && 'privateKey' in this.signer
      ? String((this.signer as any).privateKey ?? '')
      : '';
    if (!raw) {
      throw new EvalancheError(
        'Polymarket redemption requires a signer with a privateKey',
        EvalancheErrorCode.SIGNER_NOT_FOUND,
      );
    }
    return (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  }

  private getOptionalPrivateKey(): string | undefined {
    const raw = typeof this.signer === 'object' && this.signer && 'privateKey' in this.signer
      ? String((this.signer as any).privateKey ?? '')
      : '';
    if (!raw) return undefined;
    return raw.startsWith('0x') ? raw : `0x${raw}`;
  }

  private async createPolygonClients(): Promise<{
    account: { address: `0x${string}` };
    walletClient: any;
    publicClient: any;
  }> {
    const { createPublicClient, createWalletClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(this.requirePrivateKey());
    const transport = http();

    return {
      account,
      walletClient: createWalletClient({ account, chain: polygon, transport }),
      publicClient: createPublicClient({ chain: polygon, transport }),
    };
  }

  private async readUsdcBalance(publicClient: any, address: `0x${string}`): Promise<bigint> {
    return await publicClient.readContract({
      address: POLYMARKET_USDC_E as `0x${string}`,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address],
    }) as bigint;
  }

  private async bridgeRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    expectedStatus: number[] = [200],
  ): Promise<T> {
    const response = await safeFetch(new URL(path, POLYMARKET_BRIDGE_HOST), {
      method,
      headers: {
        ...polymarketHeaders(),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 15_000,
      maxBytes: 1_000_000,
      blockPrivateNetwork: true,
    });

    if (!expectedStatus.includes(response.status)) {
      const responseText = await response.text().catch(() => '');
      let message = `Bridge request failed with status ${response.status}`;
      if (responseText) {
        try {
          const parsed = JSON.parse(responseText) as Record<string, unknown>;
          const candidate = parsed.message ?? parsed.error ?? parsed.detail;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            message = candidate;
          } else {
            message = `${message}: ${responseText.slice(0, 240)}`;
          }
        } catch {
          message = `${message}: ${responseText.slice(0, 240)}`;
        }
      }
      throw new EvalancheError(message, EvalancheErrorCode.BRIDGE_FAILED);
    }

    return await response.json() as T;
  }

  private async getBridgeQuote(params: {
    amountBaseUnit: string;
    toChainId: string;
    toTokenAddress: string;
    recipientAddr: string;
  }): Promise<PolymarketBridgeQuote> {
    const payload = await this.bridgeRequest<BridgeQuoteRecord>(
      'POST',
      '/quote',
      {
        fromAmountBaseUnit: params.amountBaseUnit,
        fromChainId: '137',
        fromTokenAddress: POLYMARKET_USDC_E,
        recipientAddress: params.recipientAddr,
        toChainId: params.toChainId,
        toTokenAddress: params.toTokenAddress,
      },
      [200],
    );
    const quote = normalizeBridgeQuote(payload);
    if (!quote.quoteId) {
      throw new EvalancheError(
        'Polymarket bridge quote response did not include a quoteId',
        EvalancheErrorCode.BRIDGE_QUOTE_FAILED,
      );
    }
    return quote;
  }

  private async createWithdrawalAddresses(params: {
    address: `0x${string}`;
    toChainId: string;
    toTokenAddress: string;
    recipientAddr: string;
  }): Promise<{ addresses: PolymarketBridgeAddresses; note?: string }> {
    const payload = await this.bridgeRequest<BridgeWithdrawalAddressRecord>(
      'POST',
      '/withdraw',
      {
        address: params.address,
        toChainId: params.toChainId,
        toTokenAddress: params.toTokenAddress,
        recipientAddr: params.recipientAddr,
      },
      [201],
    );
    return {
      addresses: normalizeBridgeAddresses(payload.address),
      note: typeof payload.note === 'string' ? payload.note : undefined,
    };
  }

  private async getBridgeStatus(address: string): Promise<{ transactions: PolymarketBridgeStatusTransaction[] }> {
    const payload = await this.bridgeRequest<BridgeStatusRecord>(
      'GET',
      `/status/${encodeURIComponent(address)}`,
      undefined,
      [200],
    );
    return {
      transactions: Array.isArray(payload.transactions)
        ? payload.transactions.map((entry) => normalizeBridgeStatusTransaction(entry))
        : [],
    };
  }

  private async readPayoutVector(publicClient: any, conditionId: `0x${string}`): Promise<bigint[]> {
    const denominator = await publicClient.readContract({
      address: POLYMARKET_CTF as `0x${string}`,
      abi: CTF_REDEEM_ABI,
      functionName: 'payoutDenominator',
      args: [conditionId],
    }) as bigint;

    if (denominator <= 0n) {
      throw new EvalancheError(
        `Market is not resolved on the Conditional Tokens Framework yet: ${conditionId}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
      );
    }

    return await Promise.all(
      [0n, 1n].map(async (index) => publicClient.readContract({
        address: POLYMARKET_CTF as `0x${string}`,
        abi: CTF_REDEEM_ABI,
        functionName: 'payoutNumerators',
        args: [conditionId, index],
      }) as Promise<bigint>),
    );
  }

  private async readTokenBalances(
    publicClient: any,
    owner: `0x${string}`,
    tokens: PolymarketToken[],
  ): Promise<Array<{ tokenId: string; outcome?: string; raw: string }>> {
    const redeemableTokens = tokens.filter((token) => /^\d+$/.test(token.tokenId));
    if (redeemableTokens.length === 0) return [];

    const balances = await publicClient.readContract({
      address: POLYMARKET_CTF as `0x${string}`,
      abi: CTF_REDEEM_ABI,
      functionName: 'balanceOfBatch',
      args: [
        redeemableTokens.map(() => owner),
        redeemableTokens.map((token) => BigInt(token.tokenId)),
      ],
    }) as bigint[];

    return redeemableTokens.map((token, index) => ({
      tokenId: token.tokenId,
      outcome: token.outcome,
      raw: String(balances[index] ?? 0n),
    }));
  }

  private unwrapCliList(payload: unknown): any[] {
    if (Array.isArray(payload)) return payload;
    const record = (payload ?? {}) as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.orders)) return record.orders;
    if (Array.isArray(record.trades)) return record.trades;
    if (Array.isArray(record.positions)) return record.positions;
    return [];
  }

  private normalizeCliOrderResult(payload: unknown): PolymarketOrderResult {
    const record = (payload ?? {}) as Record<string, unknown>;
    return {
      orderID: String(record.orderID ?? record.order_id ?? record.id ?? ''),
      status: String(record.status ?? (record.success === false ? 'REJECTED' : 'SUBMITTED')),
      averageFillPrice: toNumber(record.averageFillPrice ?? record.average_fill_price),
    };
  }

  private async getLiveMarketsPage(options?: { limit?: number; cursor?: string }): Promise<{
    markets: PolymarketMarket[];
    nextCursor?: string;
  }> {
    const limit = Math.min(options?.limit ?? 100, 500);

    try {
      const url = new URL('/markets', POLYMARKET_CLOB_HOST);
      url.searchParams.set('limit', String(limit));
      if (options?.cursor) url.searchParams.set('cursor', options.cursor);

      const response = await safeFetch(url.toString(), {
        headers: polymarketHeaders(),
        timeoutMs: 12_000,
        maxBytes: 2_000_000,
      });

      if (response.ok) {
        const payload = await response.json() as { data?: ClobMarketRecord[]; next_cursor?: string };
        const records = Array.isArray(payload.data) ? payload.data : [];
        return {
          markets: records.filter(isLiveClobMarket).map(normalizeClobMarket),
          nextCursor: typeof payload.next_cursor === 'string' && payload.next_cursor.length > 0
            ? payload.next_cursor
            : undefined,
        };
      }
    } catch {
      // Fall through to Gamma fallback
    }

    return {
      markets: await this.getMarkets({ limit, closed: false, cursor: options?.cursor }),
      nextCursor: undefined,
    };
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

      const payload = await response.json() as unknown;
      const records = Array.isArray(payload) ? payload as GammaMarketRecord[] : [];
      return records
        .filter(isSearchableGammaMarket)
        .map(normalizeMarketRecord);
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch markets: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get active markets from the CLOB API (live, no auth required for reads).
   * Falls back to Gamma if CLOB is unavailable.
   */
  async getLiveMarkets(options?: { limit?: number; cursor?: string }): Promise<PolymarketMarket[]> {
    const { markets } = await this.getLiveMarketsPage(options);
    return markets;
  }

  async searchMarkets(query: string, limit = 10): Promise<PolymarketMarket[]> {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const pageSize = 100;
    const maxPages = 10;
    const matches: PolymarketMarket[] = [];
    const seen = new Set<string>();

    // Try CLOB live markets first (active, current markets)
    let cursor: string | undefined;
    for (let page = 0; page < maxPages && matches.length < limit; page++) {
      const { markets, nextCursor } = await this.getLiveMarketsPage({
        limit: pageSize,
        cursor,
      });

      if (markets.length === 0) break;

      for (const market of markets) {
        const haystack = `${market.question} ${market.description ?? ''}`.toLowerCase();
        if (haystack.includes(q) && hasSearchableMarketIdentity(market) && !seen.has(market.conditionId)) {
          matches.push(market);
          seen.add(market.conditionId);
        }
        if (matches.length >= limit) break;
      }

      if (!nextCursor) break;
      cursor = nextCursor;
    }

    // If CLOB returned nothing, try Gamma (includes historical/closed markets)
    if (matches.length === 0) {
      for (let page = 0; page < maxPages && matches.length < limit; page++) {
        const markets = await this.getMarkets({
          limit: pageSize,
          closed: false,
          cursor: String(page * pageSize),
        });

        if (markets.length === 0) break;

        for (const market of markets) {
          const haystack = `${market.question} ${market.description ?? ''}`.toLowerCase();
          if (haystack.includes(q) && hasSearchableMarketIdentity(market) && !seen.has(market.conditionId)) {
            matches.push(market);
            seen.add(market.conditionId);
          }
          if (matches.length >= limit) break;
        }

        if (markets.length < pageSize) break;
      }
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
      return normalizePolymarketOrderBook({
        bids: mapOrders(book?.bids),
        asks: mapOrders(book?.asks),
      });
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
      return normalizePolymarketOrderBook({
        bids: mapOrders(book.bids),
        asks: mapOrders(book.asks),
      });
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

  /**
   * Place a direct CLOB order when the outcome token ID, price, and size are known.
   * Supports both BUY and SELL.
   */
  async placeOrder(params: PolymarketOrderParams): Promise<PolymarketOrderResult> {
    try {
      const order = await this.cli.createOrder({
        tokenId: params.tokenId,
        price: params.price,
        size: params.size,
        side: params.side === PolymarketSide.BUY ? 'buy' : 'sell',
      });
      return this.normalizeCliOrderResult(order);
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
      await this.cli.cancelOrder(orderId);
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
      return await this.cli.order(orderId);
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
      return this.unwrapCliList(await this.cli.openOrders(tokenId));
    } catch (error) {
      throw new EvalancheError(
        `Failed to get open orders: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private getSignerAddress(): string {
    const address = typeof this.signer === 'object' && this.signer && 'address' in this.signer
      ? String((this.signer as any).address ?? '')
      : '';
    if (!address) {
      throw new EvalancheError(
        'Polymarket signer does not expose an address',
        EvalancheErrorCode.SIGNER_NOT_FOUND,
      );
    }
    return address;
  }

  async getPositions(): Promise<any[]> {
    try {
      const walletAddress = this.getSignerAddress();
      return this.unwrapCliList(await this.cli.positions(walletAddress));
    } catch (error) {
      throw new EvalancheError(
        `Failed to get positions: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async getBalances(tokenId?: string): Promise<any> {
    try {
      const [collateral, conditional] = await Promise.all([
        this.cli.balance('collateral'),
        tokenId ? this.cli.balance('conditional', tokenId) : Promise.resolve(null),
      ]);
      return {
        walletAddress: this.getSignerAddress(),
        collateral,
        conditional,
      };
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
      return this.unwrapCliList(await this.cli.trades(tokenId));
    } catch (error) {
      throw new EvalancheError(
        `Failed to get trade history: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Estimate the average fill price from the visible order book depth.
   * Returns `0` if there is not enough liquidity to fill the requested size.
   */
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

  /**
   * Place a market SELL order for an outcome token.
   *
   * This helper accepts a target USDC proceeds amount rather than a token size.
   * It uses the current best bid to estimate size before submission, then
   * returns the realized fill details from the posted order.
   */
  async placeMarketSellOrder(params: {
    conditionId: string;
    outcome: string;
    amountUSDC: number;
    maxSlippagePct?: number;
  }): Promise<{
    orderID: string;
    status: string;
    size: number;
    averageFillPrice: number;
    totalUSDC: number;
    tokenId: string;
  }> {
    const { conditionId, outcome, amountUSDC } = params;

    // Get market to find tokenId (unauthenticated read is fine)
    const market = await this.getMarket(conditionId);
    if (!market) throw new EvalancheError(`Market not found: ${conditionId}`, EvalancheErrorCode.INVALID_PARAMS);

    const token = market.tokens.find((t) => t.outcome.toUpperCase() === outcome.toUpperCase());
    if (!token) throw new EvalancheError(`Outcome ${outcome} not found in market`);
    const tokenId = token.tokenId;

    // Get current best bid to calculate token size
    const orderBook = await this.getOrderBook(tokenId);
    const bestBid = orderBook.bids?.[0]?.price;

    if (!bestBid || bestBid <= 0) {
      throw new EvalancheError(
        `No bids available for ${outcome} outcome. Cannot place sell order.`,
        EvalancheErrorCode.SWAP_FAILED,
      );
    }

    // Size = USDC target / best bid (how many tokens to sell)
    const size = amountUSDC / bestBid;

    const orderResult = await this.cli.marketOrder({
      tokenId,
      side: 'sell',
      amount: size,
      orderType: 'FAK',
    }) as Record<string, unknown>;

    const avgPrice = toNumber(orderResult.average_fill_price ?? orderResult.averageFillPrice) ?? bestBid;
    const filledSize = toNumber(orderResult.size) ?? size;
    const orderIds = Array.isArray(orderResult.orderIds) ? orderResult.orderIds : [];

    return {
      orderID: String(orderResult?.orderID ?? orderResult?.order_id ?? orderIds[0] ?? 'unknown'),
      status: String(orderResult?.status ?? 'SUBMITTED'),
      size: filledSize,
      averageFillPrice: avgPrice,
      totalUSDC: filledSize * avgPrice,
      tokenId,
    };
  }

  async withdrawUsdc(params: {
    amountUSDC: string | number;
    toChainId: string | number;
    toTokenAddress: string;
    recipientAddr: string;
  }): Promise<PolymarketWithdrawalResult> {
    const rawAmount = String(params.amountUSDC ?? '').trim();
    const toChainId = String(params.toChainId ?? '').trim();
    const toTokenAddress = String(params.toTokenAddress ?? '').trim();
    const recipientAddr = String(params.recipientAddr ?? '').trim();

    if (!rawAmount || Number(rawAmount) <= 0) {
      throw new EvalancheError(
        `Invalid amountUSDC: expected a positive number, got ${params.amountUSDC}`,
        EvalancheErrorCode.INVALID_PARAMS,
      );
    }
    if (!toChainId) {
      throw new EvalancheError('pm_withdraw requires toChainId', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (!toTokenAddress) {
      throw new EvalancheError('pm_withdraw requires toTokenAddress', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (!recipientAddr) {
      throw new EvalancheError('pm_withdraw requires recipientAddr', EvalancheErrorCode.INVALID_PARAMS);
    }

    const { formatUnits, parseUnits } = await import('viem');
    const amountBaseUnit = parseUnits(rawAmount, 6);
    const { account, walletClient, publicClient } = await this.createPolygonClients();

    const usdcBeforeRaw = await this.readUsdcBalance(publicClient, account.address);
    if (usdcBeforeRaw < amountBaseUnit) {
      throw new EvalancheError(
        `Insufficient Polymarket wallet USDC balance. Have ${formatUnits(usdcBeforeRaw, 6)}, need ${rawAmount}.`,
        EvalancheErrorCode.INSUFFICIENT_BALANCE,
      );
    }

    const quote = await this.getBridgeQuote({
      amountBaseUnit: amountBaseUnit.toString(),
      toChainId,
      toTokenAddress,
      recipientAddr,
    });
    const withdrawalAddresses = await this.createWithdrawalAddresses({
      address: account.address,
      toChainId,
      toTokenAddress,
      recipientAddr,
    });
    const bridgeAddress = withdrawalAddresses.addresses.evm;
    if (!bridgeAddress || !/^0x[a-fA-F0-9]{40}$/.test(bridgeAddress)) {
      throw new EvalancheError(
        'Polymarket bridge did not return a usable EVM deposit address for withdrawal.',
        EvalancheErrorCode.BRIDGE_FAILED,
      );
    }

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: POLYMARKET_USDC_E as `0x${string}`,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [bridgeAddress as `0x${string}`, amountBaseUnit],
      });
    } catch (error) {
      throw new EvalancheError(
        `Failed to submit Polymarket withdrawal transfer: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSFER_FAILED,
        error instanceof Error ? error : undefined,
      );
    }

    let receipt: any;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      throw new EvalancheError(
        `Polymarket withdrawal transfer submitted but receipt lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }

    const usdcAfterRaw = await this.readUsdcBalance(publicClient, account.address);
    const bridgeStatus = await this.getBridgeStatus(bridgeAddress).catch(() => null);
    const matchingTransactions = bridgeStatus?.transactions
      ?.filter((transaction) => (
        transaction.fromAmountBaseUnit === amountBaseUnit.toString()
        && transaction.toChainId === toChainId
        && typeof transaction.toTokenAddress === 'string'
        && transaction.toTokenAddress.toLowerCase() === toTokenAddress.toLowerCase()
      ))
      .sort((left, right) => (right.createdTimeMs ?? 0) - (left.createdTimeMs ?? 0)) ?? [];

    return {
      fromChainId: '137',
      toChainId,
      fromTokenAddress: POLYMARKET_USDC_E,
      toTokenAddress,
      recipientAddr,
      quote,
      bridgeAddresses: withdrawalAddresses.addresses,
      bridgeAddress,
      bridgeNote: withdrawalAddresses.note,
      txHash,
      receiptStatus: receipt?.status === 'success' ? 'success' : 'reverted',
      blockNumber: String(receipt?.blockNumber ?? ''),
      amountBaseUnit: amountBaseUnit.toString(),
      amountUSDC: formatUnits(amountBaseUnit, 6),
      usdcBefore: {
        raw: usdcBeforeRaw.toString(),
        formatted: formatUnits(usdcBeforeRaw, 6),
      },
      usdcAfter: {
        raw: usdcAfterRaw.toString(),
        formatted: formatUnits(usdcAfterRaw, 6),
      },
      usdcDelta: {
        raw: (usdcAfterRaw - usdcBeforeRaw).toString(),
        formatted: formatUnits(usdcAfterRaw - usdcBeforeRaw, 6),
      },
      bridgeStatus,
      bridgeTransaction: matchingTransactions[0] ?? null,
    };
  }

  async redeemPositions(conditionId: string): Promise<PolymarketRedemptionResult> {
    const normalizedConditionId = this.requireConditionId(conditionId);
    const { formatUnits } = await import('viem');
    const { account, walletClient, publicClient } = await this.createPolygonClients();

    const market = await this.getMarket(normalizedConditionId).catch(() => null);
    const marketTokens = market?.tokens ?? [];
    const payoutVector = await this.readPayoutVector(publicClient, normalizedConditionId);
    const winningOutcomes = marketTokens
      .filter((token, index) => (payoutVector[index] ?? 0n) > 0n)
      .map((token) => token.outcome);

    const [usdcBeforeRaw, tokenBalancesBefore] = await Promise.all([
      this.readUsdcBalance(publicClient, account.address),
      this.readTokenBalances(publicClient, account.address, marketTokens),
    ]);

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: POLYMARKET_CTF as `0x${string}`,
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [
          POLYMARKET_USDC_E as `0x${string}`,
          POLYMARKET_PARENT_COLLECTION_ID as `0x${string}`,
          normalizedConditionId,
          [...POLYMARKET_REDEEM_INDEX_SETS],
        ],
      });
    } catch (error) {
      throw new EvalancheError(
        `Failed to submit Polymarket redemption: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }

    let receipt: any;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      throw new EvalancheError(
        `Polymarket redemption submitted but receipt lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }

    const [usdcAfterRaw, tokenBalancesAfter] = await Promise.all([
      this.readUsdcBalance(publicClient, account.address),
      this.readTokenBalances(publicClient, account.address, marketTokens),
    ]);

    return {
      conditionId: normalizedConditionId,
      txHash,
      receiptStatus: receipt?.status === 'success' ? 'success' : 'reverted',
      blockNumber: String(receipt?.blockNumber ?? ''),
      collateralToken: POLYMARKET_USDC_E,
      ctfContract: POLYMARKET_CTF,
      parentCollectionId: POLYMARKET_PARENT_COLLECTION_ID,
      indexSets: POLYMARKET_REDEEM_INDEX_SETS.map((value) => value.toString()),
      marketQuestion: market?.question,
      tokenIds: marketTokens.map((token) => token.tokenId),
      winningOutcomes,
      payoutVector: payoutVector.map((value) => value.toString()),
      usdcBefore: {
        raw: usdcBeforeRaw.toString(),
        formatted: formatUnits(usdcBeforeRaw, 6),
      },
      usdcAfter: {
        raw: usdcAfterRaw.toString(),
        formatted: formatUnits(usdcAfterRaw, 6),
      },
      usdcDelta: {
        raw: (usdcAfterRaw - usdcBeforeRaw).toString(),
        formatted: formatUnits(usdcAfterRaw - usdcBeforeRaw, 6),
      },
      tokenBalancesBefore,
      tokenBalancesAfter,
    };
  }
}
