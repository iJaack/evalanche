export type PerpVenueName = 'hyperliquid';

export type PerpMarketClass = 'validator' | 'hip3';

export interface MarketOrderParams {
  market: string;
  side: 'BUY' | 'SELL';
  size: string;
  reduceOnly?: boolean;
}

export interface LimitOrderParams {
  market: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  timeInForce?: 'GTT' | 'FOK' | 'IOC';
  goodTilSeconds?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
}

export interface PerpPosition {
  venue: PerpVenueName;
  market: string;
  marketId?: string;
  marketClass?: PerpMarketClass;
  side: 'LONG' | 'SHORT';
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  liquidationPrice?: string;
}

export interface PerpMarket {
  venue: PerpVenueName;
  ticker: string;
  marketId: string;
  marketClass: PerpMarketClass;
  status: string;
  oraclePrice: string;
  volume24H: string;
  openInterest: string;
  initialMarginFraction: string;
  maxLeverage: number;
}

