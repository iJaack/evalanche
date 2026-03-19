/**
 * Evalanche top-level public API.
 */

export { Evalanche } from './agent';
export type { EvalancheConfig } from './agent';

export { EvalancheError, EvalancheErrorCode } from './utils/errors';

export {
  generateWallet,
  createWalletFromPrivateKey,
  createWalletFromMnemonic,
} from './wallet/signer';
export type { AgentSigner, GeneratedWallet } from './wallet/signer';
export type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';

export { IdentityResolver } from './identity/resolver';
export type { AgentIdentity, IdentityConfig, TrustLevel } from './identity/types';

export { ReputationReporter } from './reputation/reporter';
export type { FeedbackSubmission } from './reputation/types';

export { X402Client, X402Facilitator } from './x402';
export type { PaymentRequirements, PayAndFetchOptions, PayAndFetchResult } from './x402';

export { BridgeClient, LiFiClient, GasZipClient, NATIVE_TOKEN } from './bridge';
export type {
  BridgeQuoteParams,
  BridgeQuote,
  TransferStatus,
  TransferStatusParams,
  LiFiToken,
  LiFiChain,
  LiFiTools,
  LiFiGasPrices,
  LiFiGasSuggestion,
  LiFiConnection,
  GasZipParams,
  GasZipQuote,
} from './bridge';

export { ArenaSwapClient } from './swap/arena';
export { YakSwapClient } from './swap/yak';

export { DydxClient, PerpClient, DYDX_MARKETS, market } from './perps';
export type {
  DydxMarketRef,
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  DydxSubaccount,
  PerpVenue,
  PerpVenueName,
} from './perps';

export { LiquidStakingClient } from './defi/liquid-staking';
export { VaultClient, YOUSD_VAULT } from './defi/vaults';
export type { StakeQuote, UnstakeQuote, VaultQuote, VaultInfo, VaultConfig } from './defi/types';

export { CoinGeckoClient } from './market/coingecko';
export { PolymarketClient, POLYMARKET_CLOB_HOST, PolymarketSide } from './polymarket';
export type {
  PolymarketChain,
  PolymarketMarket,
  PolymarketToken,
  PolymarketOrderParams,
  PolymarketOrderResult,
  PolymarketOrderBook,
  PolymarketOrder,
} from './polymarket';

export * from './economy';
export * from './interop';
