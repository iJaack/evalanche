import type { LimitOrderParams, MarketOrderParams, PerpMarket, PerpPosition } from './dydx/types';

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

export { DydxClient } from './dydx/client';
export type {
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  DydxSubaccount,
} from './dydx/types';

