export interface PMMarket {
  conditionId: string;
  question: string;
  endDate: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  tokens?: Array<{ outcome: string; token_id: string }>;
}

export interface PMPosition {
  conditionId: string;
  question: string;
  outcome: string;
  tokenId: string;
  shares: string;
  currentPrice: number;
  value: number;
}

export interface PMOrderbook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  bestBid: string;
  bestAsk: string;
  spread: string;
}

export interface PMBuyResult {
  orderId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  amountUSDC: string;
  estimatedShares: number;
  pricePerShare: number;
  /** 'market' (fills immediately at best ask) or 'limit' (GTC maker order on CLOB) */
  orderType: 'market' | 'limit';
}
