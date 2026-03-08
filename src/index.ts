// Main class
export { Evalanche } from './agent';
export type { EvalancheConfig } from './agent';

// Identity
export { IdentityResolver } from './identity/resolver';
export { IDENTITY_REGISTRY, REPUTATION_REGISTRY, IDENTITY_ABI, REPUTATION_ABI, DOMAIN_SEPARATOR } from './identity/constants';
export type { AgentIdentity, IdentityConfig, TrustLevel } from './identity/types';

// Wallet
export { createWalletFromPrivateKey, createWalletFromMnemonic, generateWallet } from './wallet/signer';
export type { AgentSigner, GeneratedWallet } from './wallet/signer';
export { AgentKeystore } from './wallet/keystore';
export type { KeystoreOptions, KeystoreInitResult } from './wallet/keystore';
export { TransactionBuilder } from './wallet/transaction';
export type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';

// Reputation
export { ReputationReporter } from './reputation/reporter';
export type { FeedbackSubmission } from './reputation/types';

// x402
export { X402Client } from './x402/client';
export { X402Facilitator } from './x402/facilitator';
export type { PaymentRequirements, PayAndFetchOptions, PayAndFetchResult } from './x402/types';

// Bridge (v0.4.0)
export { BridgeClient, LiFiClient, GasZipClient, NATIVE_TOKEN } from './bridge';
export type { BridgeQuoteParams, BridgeQuote } from './bridge/lifi';
export type { GasZipParams, GasZipQuote } from './bridge/gaszip';

// Chain Registry (v0.4.0)
export { CHAINS, CHAIN_ALIASES, getChainById, getChainByAlias, getPrimaryRpc, getAllChains } from './utils/chains';
export type { ChainConfig } from './utils/chains';

// Avalanche Multi-VM types (classes are lazy-loaded via dynamic import to avoid
// pulling in @avalabs/core-wallets-sdk and its heavy native deps at import time)
export type {
  AvalancheProvider,
  AvalancheSigner,
  ChainAlias,
  TransferResult,
  BalanceInfo,
  MultiChainBalance,
  StakeInfo,
  ValidatorInfo,
  MinStakeAmounts,
} from './avalanche';

// Platform CLI (optional subprocess wrapper for advanced P-Chain ops)
export { PlatformCLI } from './avalanche/platform-cli';
export type {
  PlatformCLIResult,
  SubnetCreateResult,
  L1RegisterResult,
  NodeInfoResult,
  AddValidatorParams,
  DelegateParams,
  ConvertToL1Params,
  PChainTransferParams,
  CrossChainTransferParams,
} from './avalanche/platform-cli';

// Swap (v0.5.0)
export { ArenaSwapClient, ARENA_TOKEN_MANAGER, ARENA_TOKEN } from './swap';
export type { ArenaTokenInfo, ArenaSwapResult } from './swap';

// Perpetuals (v0.7.0)
export { DydxClient } from './perps';
export type {
  PerpVenue,
  MarketOrderParams,
  LimitOrderParams,
  PerpPosition,
  PerpMarket,
  DydxSubaccount,
} from './perps';

// MCP
export { EvalancheMCPServer } from './mcp/server';

// Utilities
export { getNetworkConfig, NETWORKS } from './utils/networks';
export type { NetworkConfig, NetworkOption, ChainName } from './utils/networks';
export { TTLCache } from './utils/cache';
export { EvalancheError, EvalancheErrorCode } from './utils/errors';
// Secrets (OpenClaw integration)
export { resolveAgentSecrets, parseSecretRef } from './secrets';
export type { SecretsResolution } from './secrets';
