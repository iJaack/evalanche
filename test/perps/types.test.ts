import { describe, expectTypeOf, it } from 'vitest';
import type {
  LimitOrderParams,
  MarketOrderParams,
  PerpMarket,
  PerpPosition,
  PerpVenueName,
} from '../../src/perps/types';

describe('shared perp types', () => {
  it('supports the expected perp venues', () => {
    expectTypeOf<PerpVenueName>().toEqualTypeOf<'hyperliquid'>();
  });

  it('keeps shared order params venue-neutral', () => {
    expectTypeOf<MarketOrderParams>().toMatchTypeOf<{
      market: string;
      side: 'BUY' | 'SELL';
      size: string;
      reduceOnly?: boolean;
    }>();

    expectTypeOf<LimitOrderParams>().toMatchTypeOf<{
      market: string;
      side: 'BUY' | 'SELL';
      size: string;
      price: string;
    }>();
  });

  it('adds venue and market classification to shared market types', () => {
    expectTypeOf<PerpMarket>().toMatchTypeOf<{
      venue: 'hyperliquid';
      ticker: string;
      marketId: string;
      marketClass: 'validator' | 'hip3';
    }>();

    expectTypeOf<PerpPosition>().toMatchTypeOf<{
      venue: 'hyperliquid';
      market: string;
      side: 'LONG' | 'SHORT';
    }>();
  });
});

