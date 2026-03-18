/**
 * Polymarket Module — prediction market integration.
 *
 * Provides access to Polymarket's CLOB (Central Limit Order Book) for trading
 * conditional tokens (prediction market outcomes).
 *
 * @example
 * ```ts
 * import { PolymarketClient, PolymarketSide } from 'evalanche/polymarket';
 *
 * const pm = new PolymarketClient(signer);
 *
 * const markets = await pm.getMarkets({ limit: 10 });
 * const order = await pm.placeOrder({
 *   tokenId: '123456',
 *   price: 0.60,
 *   size: 100,
 *   side: PolymarketSide.BUY,
 * });
 * ```
 */

export { PolymarketClient, POLYMARKET_CLOB_HOST } from './client';
export type {
  PolymarketChain,
  PolymarketMarket,
  PolymarketToken,
  PolymarketOrderParams,
  PolymarketOrderResult,
  PolymarketOrderBook,
  PolymarketOrder,
} from './client';
export { PolymarketSide } from './client';
