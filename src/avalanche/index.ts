/**
 * Avalanche Module — C-Chain, P-Chain, X-Chain, and cross-chain operations.
 *
 * Core utilities for Avalanche blockchain interactions including:
 *   - Signers and providers
 *   - P-Chain operations (validators, delegators)
 *   - X-Chain operations (AVA, assets)
 *   - Cross-chain transfers (AVAX)
 */

export { AgentSigner, type AvalancheSigner } from './signer';
export { RpcProvider, RpcProviders } from './provider';
export { PlatformChainID, PrimaryAssetID, type AvalancheChain } from './types';

// P-Chain exports
export { addValidator, addDelegator, delegate, type ValidatorParams, type DelegatorParams } from './pchain';

// X-Chain exports
export { createAsset, mintAsset, exportXChain, importXChain, type AssetParams } from './xchain';

// Cross-chain exports
export { crossChainTransfer, type CrossChainParams } from './crosschain';

// Platform CLI (deprecated, use programmatic APIs)
export { Avalanche as AvalanchePlatformCLI } from './platform-cli';
