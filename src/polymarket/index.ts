/**
 * Polymarket Module — prediction market integration.
 *
 * Provides access to Polymarket's CLOB (Central Limit Order Book) for trading
 * conditional tokens (prediction market outcomes).
 *
 * Current feature surface:
 * - search and fetch markets
 * - fetch outcome tokens and order books
 * - estimate buy/sell fill prices from book depth
 * - inspect balances, positions, open orders, and trade history
 * - place direct BUY and SELL orders through the official Polymarket CLI
 * - market-sell helper via `placeMarketSellOrder()`
 *
 * @example
 * ```ts
 * import { PolymarketClient, PolymarketSide } from 'evalanche/polymarket';
 *
 * const pm = new PolymarketClient(signer);
 *
 * const markets = await pm.searchMarkets('bitcoin', 5);
 * const market = await pm.getMarket(markets[0].conditionId);
 * const yesToken = market?.tokens.find((token) => token.outcome === 'YES');
 *
 * const buyOrder = await pm.placeOrder({
 *   tokenId: yesToken!.tokenId,
 *   price: 0.60,
 *   size: 100,
 *   side: PolymarketSide.BUY,
 * });
 *
 * const sellOrder = await pm.placeOrder({
 *   tokenId: yesToken!.tokenId,
 *   price: 0.72,
 *   size: 25,
 *   side: PolymarketSide.SELL,
 * });
 *
 * const marketSell = await pm.placeMarketSellOrder({
 *   conditionId: market!.conditionId,
 *   outcome: 'YES',
 *   amountUSDC: 10,
 * });
 * ```
 *
 * @example
 * ```ts
 * const orderBook = await pm.getOrderBook(yesToken!.tokenId);
 * const estBuy = await pm.estimateFillPrice(yesToken!.tokenId, PolymarketSide.BUY, 50);
 * const estSell = await pm.estimateFillPrice(yesToken!.tokenId, PolymarketSide.SELL, 50);
 * const positions = await pm.getPositions();
 * const balances = await pm.getBalances();
 * ```
 */

export { PolymarketClient, POLYMARKET_BRIDGE_HOST, POLYMARKET_CLOB_HOST } from './client';
export { PolymarketCli } from './cli';
export type { PolymarketCliOptions, PolymarketCliRunner } from './cli';
export type {
  PolymarketChain,
  PolymarketMarket,
  PolymarketToken,
  PolymarketOrderParams,
  PolymarketOrderResult,
  PolymarketOrderBook,
  PolymarketOrder,
  PolymarketWithdrawalResult,
  PolymarketRedemptionResult,
} from './client';
export { PolymarketSide } from './client';
