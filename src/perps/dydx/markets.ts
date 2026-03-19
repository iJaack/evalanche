/**
 * dYdX v4 perpetual market constants.
 *
 * Reference data for the markets Mony actively monitors or trades.
 * Values sourced from dYdX mainnet indexer (2026-03-16).
 */

export interface DydxMarketRef {
  ticker: string;
  description: string;
  minOrderSize: number; // stepSize — smallest tradeable increment
  tickSize: number; // price granularity
  maxLeverage: number;
  imf: number; // initial margin fraction
  notes?: string;
}

export const DYDX_MARKETS: Record<string, DydxMarketRef> = {
  BTC: {
    ticker: "BTC-USD",
    description: "Bitcoin",
    minOrderSize: 0.0001,
    tickSize: 1,
    maxLeverage: 20,
    imf: 0.05,
  },
  ETH: {
    ticker: "ETH-USD",
    description: "Ethereum",
    minOrderSize: 0.001,
    tickSize: 0.1,
    maxLeverage: 20,
    imf: 0.05,
  },
  SOL: {
    ticker: "SOL-USD",
    description: "Solana",
    minOrderSize: 0.1,
    tickSize: 0.01,
    maxLeverage: 20,
    imf: 0.05,
  },
  AVAX: {
    ticker: "AVAX-USD",
    description: "Avalanche",
    minOrderSize: 0.1,
    tickSize: 0.01,
    maxLeverage: 10,
    imf: 0.1,
  },
  ZEC: {
    ticker: "ZEC-USD",
    description: "Zcash — privacy coin, NU7 governance catalyst",
    minOrderSize: 0.1,
    tickSize: 0.01,
    maxLeverage: 5,
    imf: 0.2,
    notes:
      "ZEC +23% 2026-03-16, NU7 catalyst. Mony watch for HB#3+ entry signal.",
  },
  HYPE: {
    ticker: "HYPE-USD",
    description: "Hyperliquid",
    minOrderSize: 0.1,
    tickSize: 0.01,
    maxLeverage: 5,
    imf: 0.2,
  },
  LINK: {
    ticker: "LINK-USD",
    description: "Chainlink",
    minOrderSize: 0.1,
    tickSize: 0.01,
    maxLeverage: 20,
    imf: 0.05,
  },
  DOGE: {
    ticker: "DOGE-USD",
    description: "Dogecoin",
    minOrderSize: 1,
    tickSize: 0.0001,
    maxLeverage: 10,
    imf: 0.1,
  },
  ARB: {
    ticker: "ARB-USD",
    description: "Arbitrum",
    minOrderSize: 1,
    tickSize: 0.0001,
    maxLeverage: 10,
    imf: 0.1,
  },
  MATIC: {
    ticker: "MATIC-USD",
    description: "Polygon",
    minOrderSize: 1,
    tickSize: 0.0001,
    maxLeverage: 10,
    imf: 0.1,
  },
};

/** Get the ticker string for a known market symbol. */
export function market(symbol: keyof typeof DYDX_MARKETS): string {
  return DYDX_MARKETS[symbol].ticker;
}
