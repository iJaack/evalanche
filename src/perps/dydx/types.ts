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
  market: string;
  side: 'LONG' | 'SHORT';
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  liquidationPrice?: string;
}

export interface PerpMarket {
  ticker: string;
  status: string;
  oraclePrice: string;
  volume24H: string;
  openInterest: string;
  initialMarginFraction: string;
  maxLeverage: number;
}

export interface DydxSubaccount {
  address: string;
  subaccountNumber: number;
  equity: string;
  freeCollateral: string;
  positions: PerpPosition[];
}

