import { createRequire } from 'module';
import { EvalancheError, EvalancheErrorCode } from '../../utils/errors';
import type { PerpVenue } from '../index';
import type {
  DydxSubaccount,
  LimitOrderParams,
  MarketOrderParams,
  PerpMarket,
  PerpPosition,
} from './types';

type DydxOrderRecord = Record<string, unknown>;
type DydxSdk = typeof import('@dydxprotocol/v4-client-js');

let dydxSdkPromise: Promise<DydxSdk> | null = null;

async function loadDydxSdk(): Promise<DydxSdk> {
  if (dydxSdkPromise) return dydxSdkPromise;

  dydxSdkPromise = (async () => {
    try {
      return await import('@dydxprotocol/v4-client-js') as DydxSdk;
    } catch (importError) {
      try {
        const req = typeof require === 'function'
          ? require
          : createRequire(import.meta.url);
        return req('@dydxprotocol/v4-client-js') as DydxSdk;
      } catch (requireError) {
        throw new EvalancheError(
          'Failed to load dYdX SDK. Install or repair @dydxprotocol/v4-client-js before using perps.',
          EvalancheErrorCode.DYDX_ERROR,
          requireError instanceof Error ? requireError : importError instanceof Error ? importError : undefined,
        );
      }
    }
  })();

  return dydxSdkPromise;
}

export class DydxClient implements PerpVenue {
  readonly name = 'dydx';

  private readonly mnemonic: string;
  private readonly network?: unknown;
  private wallet?: any;
  private client?: any;
  private subaccount?: any;

  constructor(mnemonic: string, network?: unknown) {
    this.mnemonic = mnemonic;
    this.network = network;
  }

  /** Connect to dYdX and initialize wallet + default subaccount. */
  async connect(): Promise<void> {
    if (this.client && this.subaccount && this.wallet) return;

    try {
      const sdk = await loadDydxSdk();
      const network = this.network ?? sdk.Network.mainnet();
      this.wallet = await sdk.LocalWallet.fromMnemonic(this.mnemonic, sdk.BECH32_PREFIX);
      this.client = await sdk.CompositeClient.connect(network as any);
      this.subaccount = sdk.SubaccountClient.forLocalWallet(this.wallet, 0);
    } catch (cause) {
      throw new EvalancheError(
        'Failed to initialize dYdX client',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Get dYdX bech32 address for the configured wallet. */
  async getAddress(): Promise<string> {
    await this.connect();
    return this.getWalletAddress();
  }

  /** Get dYdX subaccount details, including balance and open positions. */
  async getSubaccount(subaccountNumber = 0): Promise<DydxSubaccount> {
    await this.connect();

    try {
      const client = this.client!;
      const address = this.getWalletAddress();
      const raw = await client.indexerClient.account.getSubaccount(address, subaccountNumber) as Record<string, unknown>;
      const data = (raw.subaccount as Record<string, unknown> | undefined) ?? raw;
      const positions = await this.getPositions(subaccountNumber);

      return {
        address,
        subaccountNumber,
        equity: this.pickString(data, ['equity', 'quoteBalance', 'totalValue'], '0'),
        freeCollateral: this.pickString(data, ['freeCollateral', 'freeCollateralQuote', 'availableBalance'], '0'),
        positions,
      };
    } catch (cause) {
      throw new EvalancheError(
        'Failed to fetch dYdX subaccount',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Get USDC equity from the default subaccount. */
  async getBalance(): Promise<string> {
    const subaccount = await this.getSubaccount(0);
    return subaccount.equity;
  }

  /** Get open perpetual positions for a subaccount. */
  async getPositions(subaccountNumber = 0): Promise<PerpPosition[]> {
    await this.connect();

    try {
      const address = this.getWalletAddress();
      const raw = await this.client!.indexerClient.account.getSubaccountPerpetualPositions(address, subaccountNumber) as Record<string, unknown>;
      const list = this.pickArray(raw, ['positions', 'perpetualPositions', 'subaccountPerpetualPositions']);

      return list
        .map((item) => this.mapPosition(item))
        .filter((position): position is PerpPosition => Boolean(position));
    } catch (cause) {
      throw new EvalancheError(
        'Failed to fetch dYdX positions',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** List available perpetual markets. */
  async getMarkets(): Promise<PerpMarket[]> {
    await this.connect();

    try {
      const raw = await this.client!.indexerClient.markets.getPerpetualMarkets() as Record<string, unknown>;
      const list = this.pickArray(raw, ['markets', 'perpetualMarkets']);

      return list
        .map((item) => this.mapMarket(item))
        .filter((market): market is PerpMarket => Boolean(market));
    } catch (cause) {
      throw new EvalancheError(
        'Failed to fetch dYdX markets',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Check whether a market exists on dYdX. */
  async hasMarket(ticker: string): Promise<boolean> {
    const markets = await this.getMarkets();
    return markets.some((market) => market.ticker.toUpperCase() === ticker.toUpperCase());
  }

  /** Place a market order and return an order identifier. */
  async placeMarketOrder(params: MarketOrderParams): Promise<string> {
    await this.connect();

    if (!(await this.hasMarket(params.market))) {
      throw new EvalancheError(
        `Unknown dYdX market: ${params.market}`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    try {
      const price = await this.getMarketReferencePrice(params.market);
      const sdk = await loadDydxSdk();
      const side = params.side === 'BUY' ? sdk.OrderSide.BUY : sdk.OrderSide.SELL;
      const adjustedPrice = side === sdk.OrderSide.BUY ? price * 1.01 : price * 0.99;
      const goodTil = Math.floor(Date.now() / 1000) + 120;
      const clientId = this.randomClientId();

      await this.client!.placeOrder(
        this.subaccount!,
        params.market,
        sdk.OrderType.MARKET,
        side,
        adjustedPrice,
        Number(params.size),
        clientId,
        sdk.OrderTimeInForce.FOK,
        goodTil,
        undefined,
        false,
        params.reduceOnly ?? false,
      );

      return `${params.market}:${clientId}:32`;
    } catch (cause) {
      throw new EvalancheError(
        `Failed to place dYdX market order on ${params.market}`,
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Place a limit order and return an order identifier. */
  async placeLimitOrder(params: LimitOrderParams): Promise<string> {
    await this.connect();

    if (!(await this.hasMarket(params.market))) {
      throw new EvalancheError(
        `Unknown dYdX market: ${params.market}`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    try {
      const sdk = await loadDydxSdk();
      const side = params.side === 'BUY' ? sdk.OrderSide.BUY : sdk.OrderSide.SELL;
      const tif = await this.mapTimeInForce(params.timeInForce);
      const goodTil = params.goodTilSeconds ?? (Math.floor(Date.now() / 1000) + 3600);
      const clientId = this.randomClientId();

      await this.client!.placeOrder(
        this.subaccount!,
        params.market,
        sdk.OrderType.LIMIT,
        side,
        Number(params.price),
        Number(params.size),
        clientId,
        tif,
        goodTil,
        undefined,
        params.postOnly ?? false,
        params.reduceOnly ?? false,
      );

      return `${params.market}:${clientId}:64`;
    } catch (cause) {
      throw new EvalancheError(
        `Failed to place dYdX limit order on ${params.market}`,
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Cancel an existing order using an encoded order identifier. */
  async cancelOrder(orderId: string): Promise<void> {
    await this.connect();

    try {
      const { market, clientId, orderFlags } = this.parseOrderId(orderId);
      await this.client!.cancelOrder(this.subaccount!, clientId, orderFlags, market);
    } catch (cause) {
      throw new EvalancheError(
        `Failed to cancel dYdX order: ${orderId}`,
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Get subaccount orders from indexer API. */
  async getOrders(status?: string, subaccountNumber = 0): Promise<Array<DydxOrderRecord & { orderId: string }>> {
    await this.connect();

    try {
      const address = this.getWalletAddress();
      const raw = await this.client!.indexerClient.account.getSubaccountOrders(
        address,
        subaccountNumber,
        null,
        undefined,
        null,
        status as never,
      ) as Record<string, unknown>;

      const list = this.pickArray(raw, ['orders', 'subaccountOrders']);
      return list.map((entry) => {
        const market = this.pickString(entry, ['ticker', 'market', 'marketId'], '');
        const clientId = Number(this.pickString(entry, ['clientId'], '0'));
        const flags = Number(this.pickString(entry, ['orderFlags'], '0'));

        return {
          ...entry,
          orderId: `${market}:${clientId}:${flags}`,
        };
      });
    } catch (cause) {
      throw new EvalancheError(
        'Failed to fetch dYdX orders',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Close an open position by placing a reduce-only market order. */
  async closePosition(market: string): Promise<string> {
    const positions = await this.getPositions();
    const match = positions.find((position) => position.market.toUpperCase() === market.toUpperCase());

    if (!match) {
      throw new EvalancheError(
        `No open position found for market: ${market}`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    const side = match.side === 'LONG' ? 'SELL' : 'BUY';
    return this.placeMarketOrder({
      market: match.market,
      side,
      size: match.size,
      reduceOnly: true,
    });
  }

  /** Deposit USDC from wallet to dYdX default subaccount. */
  async deposit(amount: string): Promise<string> {
    await this.connect();

    try {
      const tx = await this.client!.depositToSubaccount(this.subaccount!, amount);
      return this.extractTxHash(tx);
    } catch (cause) {
      throw new EvalancheError(
        'Failed to deposit to dYdX subaccount',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /** Withdraw USDC from dYdX default subaccount to wallet address. */
  async withdraw(amount: string): Promise<string> {
    await this.connect();

    try {
      const tx = await this.client!.withdrawFromSubaccount(this.subaccount!, amount);
      return this.extractTxHash(tx);
    } catch (cause) {
      throw new EvalancheError(
        'Failed to withdraw from dYdX subaccount',
        EvalancheErrorCode.DYDX_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  private randomClientId(): number {
    return Math.floor(Math.random() * 1_000_000_000);
  }

  private getWalletAddress(): string {
    const address = this.wallet?.address;
    if (!address) {
      throw new EvalancheError(
        'dYdX wallet address is unavailable',
        EvalancheErrorCode.DYDX_ERROR,
      );
    }
    return address;
  }

  private async mapTimeInForce(tif?: LimitOrderParams['timeInForce']): Promise<unknown> {
    const sdk = await loadDydxSdk();
    if (tif === 'IOC') return sdk.OrderTimeInForce.IOC;
    if (tif === 'FOK') return sdk.OrderTimeInForce.FOK;
    return sdk.OrderTimeInForce.GTT;
  }

  private async getMarketReferencePrice(ticker: string): Promise<number> {
    const markets = await this.getMarkets();
    const match = markets.find((market) => market.ticker.toUpperCase() === ticker.toUpperCase());
    if (!match) {
      throw new EvalancheError(
        `Unknown dYdX market: ${ticker}`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    const parsed = Number(match.oraclePrice);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new EvalancheError(
        `Invalid oracle price for market: ${ticker}`,
        EvalancheErrorCode.DYDX_ERROR,
      );
    }
    return parsed;
  }

  private mapPosition(item: Record<string, unknown>): PerpPosition | null {
    const market = this.pickString(item, ['ticker', 'market', 'marketId'], '');
    const size = this.pickString(item, ['size', 'sumOpen', 'openSize'], '0');
    if (!market || size === '0') return null;

    const sideField = this.pickString(item, ['side'], '');
    const side = sideField === 'LONG' || sideField === 'SHORT'
      ? sideField
      : (Number(size) >= 0 ? 'LONG' : 'SHORT');

    return {
      market,
      side,
      size: String(Math.abs(Number(size))),
      entryPrice: this.pickString(item, ['entryPrice', 'entryPriceQuote'], '0'),
      unrealizedPnl: this.pickString(item, ['unrealizedPnl', 'unrealizedPnlQuote'], '0'),
      liquidationPrice: this.pickString(item, ['liquidationPrice'], undefined),
    };
  }

  private mapMarket(item: Record<string, unknown>): PerpMarket | null {
    const ticker = this.pickString(item, ['ticker', 'market', 'id'], '');
    if (!ticker) return null;

    const initialMarginFraction = this.pickString(item, ['initialMarginFraction'], '0');
    const imf = Number(initialMarginFraction);

    return {
      ticker,
      status: this.pickString(item, ['status'], 'UNKNOWN'),
      oraclePrice: this.pickString(item, ['oraclePrice'], '0'),
      volume24H: this.pickString(item, ['volume24H', 'volume24h'], '0'),
      openInterest: this.pickString(item, ['openInterest'], '0'),
      initialMarginFraction,
      maxLeverage: imf > 0 ? Number((1 / imf).toFixed(2)) : 0,
    };
  }

  private parseOrderId(orderId: string): { market: string; clientId: number; orderFlags: number } {
    const parts = orderId.split(':');
    if (parts.length < 2) {
      throw new EvalancheError(
        `Invalid orderId format: ${orderId}. Expected market:clientId[:orderFlags]`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    const market = parts[0];
    const clientId = Number(parts[1]);
    const orderFlags = Number(parts[2] ?? '0');

    if (!market || Number.isNaN(clientId) || Number.isNaN(orderFlags)) {
      throw new EvalancheError(
        `Invalid orderId format: ${orderId}. Expected market:clientId[:orderFlags]`,
        EvalancheErrorCode.PERPS_ERROR,
      );
    }

    return { market, clientId, orderFlags };
  }

  private extractTxHash(tx: unknown): string {
    if (typeof tx === 'string') return tx;
    if (tx && typeof tx === 'object') {
      const record = tx as Record<string, unknown>;
      const value = record.transactionHash ?? record.txhash ?? record.hash;
      if (typeof value === 'string' && value.length > 0) return value;
    }

    return JSON.stringify(tx);
  }

  private pickString(
    record: Record<string, unknown>,
    keys: string[],
    fallback: string | undefined,
  ): string {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null) return String(value);
    }
    return fallback ?? '';
  }

  private pickArray(record: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
      }
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>)
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
      }
    }
    return [];
  }
}
