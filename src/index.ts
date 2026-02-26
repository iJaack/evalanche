// Main class
export { Evalanche } from './agent';
export type { EvalancheConfig } from './agent';

// Identity
export { IdentityResolver } from './identity/resolver';
export { IDENTITY_REGISTRY, REPUTATION_REGISTRY, IDENTITY_ABI, REPUTATION_ABI, DOMAIN_SEPARATOR } from './identity/constants';
export type { AgentIdentity, IdentityConfig, TrustLevel } from './identity/types';

// Wallet
export { createWalletFromPrivateKey, createWalletFromMnemonic } from './wallet/signer';
export type { AgentSigner } from './wallet/signer';
export { TransactionBuilder } from './wallet/transaction';
export type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';

// Reputation
export { ReputationReporter } from './reputation/reporter';
export type { FeedbackSubmission } from './reputation/types';

// x402
export { X402Client } from './x402/client';
export { X402Facilitator } from './x402/facilitator';
export type { PaymentRequirements, PayAndFetchOptions, PayAndFetchResult } from './x402/types';

// MCP
export { EvalancheMCPServer } from './mcp/server';

// Utilities
export { getNetworkConfig, NETWORKS } from './utils/networks';
export type { NetworkConfig, NetworkOption } from './utils/networks';
export { TTLCache } from './utils/cache';
export { EvalancheError, EvalancheErrorCode } from './utils/errors';
