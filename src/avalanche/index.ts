/**
 * Avalanche Module — C-Chain, P-Chain, X-Chain, and cross-chain operations.
 *
 * Core utilities for Avalanche blockchain interactions including:
 *   - Signers and providers
 *   - P-Chain operations (validators, delegators)
 *   - X-Chain operations (AVA, assets)
 *   - Cross-chain transfers (AVAX)
 */

export { createAvalancheSigner, type AvalancheSigner } from './signer';
export { createAvalancheProvider, getAvalancheContext, clearProviderCache, type AvalancheProvider } from './provider';
export type { ChainAlias, TransferResult, BalanceInfo, MultiChainBalance, StakeInfo, ValidatorInfo, MinStakeAmounts } from './types';

// P-Chain exports
export { PChainOperations } from './pchain';

// X-Chain exports
export { XChainOperations } from './xchain';

// Cross-chain exports
export { CrossChainTransfer } from './crosschain';

// Platform CLI
export { PlatformCLI, type PlatformCLIResult, type SubnetCreateResult, type L1RegisterResult, type NodeInfoResult, type AddValidatorParams, type DelegateParams, type ConvertToL1Params, type PChainTransferParams, type CrossChainTransferParams } from './platform-cli';

export { listAvalancheL1s, getAvalancheL1Network } from './l1';
export type { AvalancheL1, AvalancheL1Options } from './l1';
