/**
 * Evalanche top-level public API.
 */

export { Evalanche } from './agent';
export type { EvalancheConfig } from './agent';

export {
  RemoteSignerClient,
  EvalancheSignerServer,
  startSignerServer,
  canonicalIntentJson,
  canonicalJson,
  computeApprovedTxHash,
  computeIntentHash,
  computeMessageRouteHash,
  computeRequestRouteHash,
  computeRouteHash,
  generateEd25519KeyPair,
  signIntentHash,
  signVerifierApproval,
  verifyIntentHash,
  isRemoteSignerConfig,
  isSigningProvider,
  AUDIT_ROOT,
  HARD_MAX_GAS_COST_WEI,
} from './signer';
export type {
  CanonicalSigningRequest,
  RemoteSignerConfig,
  SigningContext,
  SigningIntent,
  SigningProvider,
  SigningResult,
  TokenRef,
  VerifierApproval,
  SignerServerOptions,
} from './signer';

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
export { KYBER_AGGREGATOR_API, KYBER_ROUTE_CHAIN_IDS, KYBER_ROUTE_CHAINS, assembleLifiV3FromKyber, buildKyberLifiSwap, kyberRouteChain } from './bridge/kyber-route';
export type { KyberLifiSwap, KyberLifiSwapOptions, KyberLifiSwapRequest, KyberReferenceRequest, KyberRouteChain, KyberSignerPins } from './bridge/kyber-route';
export { buildDirectDexSwap } from './bridge/direct-route';
export type { DirectDexSwap, DirectDexSwapRequest } from './bridge/direct-route';
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

export { HyperliquidClient, PerpClient } from './perps';
export type {
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
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
export { COINGECKO_SIMPLE_PRICE_URL, NATIVE_COINGECKO_IDS, parseCoinGeckoSimplePrice } from './signer/price-feed';
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

export { listAvalancheL1s, getAvalancheL1Network } from './avalanche/l1';
export type { AvalancheL1, AvalancheL1Options } from './avalanche/l1';
