import { describe, expectTypeOf, it } from 'vitest';
import type {
  DydxSubaccount,
  LimitOrderParams,
  MarketOrderParams,
  PerpMarket,
  PerpPosition,
} from '../../../src/perps/dydx/types';

describe('dydx perp types', () => {
  it('validates market order params type', () => {
    expectTypeOf<MarketOrderParams>().toMatchTypeOf<{
      market: string;
      side: 'BUY' | 'SELL';
      size: string;
      reduceOnly?: boolean;
    }>();
  });

  it('validates limit order params type', () => {
    expectTypeOf<LimitOrderParams>().toMatchTypeOf<{
      market: string;
      side: 'BUY' | 'SELL';
      size: string;
      price: string;
      timeInForce?: 'GTT' | 'FOK' | 'IOC';
      goodTilSeconds?: number;
      reduceOnly?: boolean;
      postOnly?: boolean;
    }>();
  });

  it('validates perp market, position, and subaccount shapes', () => {
    expectTypeOf<PerpPosition>().toMatchTypeOf<{
      market: string;
      side: 'LONG' | 'SHORT';
      size: string;
      entryPrice: string;
      unrealizedPnl: string;
      liquidationPrice?: string;
    }>();

    expectTypeOf<PerpMarket>().toMatchTypeOf<{
      ticker: string;
      status: string;
      oraclePrice: string;
      volume24H: string;
      openInterest: string;
      initialMarginFraction: string;
      maxLeverage: number;
    }>();

    expectTypeOf<DydxSubaccount>().toMatchTypeOf<{
      address: string;
      subaccountNumber: number;
      equity: string;
      freeCollateral: string;
      positions: PerpPosition[];
    }>();
  });
});

