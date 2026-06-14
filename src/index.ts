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
  LiFiExecutionResult,
  LiFiBalanceSnapshot,
  LiFiRouteOrder,
  LiFiRouteStrategy,
  LiFiTimingStrategy,
  GasZipParams,
  GasZipQuote,
} from './bridge';

export { ArenaSwapClient } from './swap/arena';
export { YieldYakClient } from './swap/yak';

export { DydxClient, HyperliquidClient, PerpClient, DYDX_MARKETS, market } from './perps';
export type {
  DydxMarketRef,
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  DydxSubaccount,
  HyperliquidAccountState,
  HyperliquidExecutionResult,
  HyperliquidMarket,
  HyperliquidMarketMetadata,
  HyperliquidOpenOrder,
  HyperliquidOrderStatus,
  HyperliquidPosition,
  HyperliquidTrade,
  PerpVenue,
  PerpMarketClass,
  PerpVenueName,
} from './perps';

export { LiquidStakingClient } from './defi/liquid-staking';
export { VaultClient, YOUSD_VAULT } from './defi/vaults';
export {
  AvaPilotRegistryProvider,
  CompositeDappRegistry,
  LocalCanonicalDappRegistryProvider,
  createDefaultDappRegistry,
  parseInteroperableAddress,
  resolveDappTarget,
} from './defi/dapp-registry';
export type { StakeQuote, UnstakeQuote, VaultQuote, VaultInfo, VaultConfig } from './defi/types';

export { HoldingsClient, UniversalHoldingsRegistry, createUniversalHoldingsRegistry } from './holdings';
export type {
  AssetRecord,
  HoldingRecord,
  HoldingType,
  HoldingsInclude,
  HoldingsNetwork,
  HoldingsRegistrySource,
  HoldingsScanOptions,
  HoldingsScanResult,
  PositionSourceKind,
  PositionSourceRecord,
  ProtocolRecord,
  RegistrySearchResult,
  RegistryStatusResult,
} from './holdings';

export { CoinGeckoClient } from './market/coingecko';
export { PolymarketCli, PolymarketClient, POLYMARKET_CLOB_HOST, PolymarketSide } from './polymarket';
export type {
  PolymarketCliOptions,
  PolymarketCliRunner,
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
export { EvalancheMCPServer } from './mcp/server';
