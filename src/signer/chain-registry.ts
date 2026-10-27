/**
 * Chains the signer is willing to enable.
 *
 * The nineteen mainnets below are the registry. Avalanche C-Chain (43114) is
 * the only chain enabled by default. A chain flagged `isTestnet` in the EVM
 * registry cannot be enabled, including by an explicit config flag.
 */

import { CHAINS } from '../utils/chains';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const SIGNER_MAINNET_IDS = [
  1, 10, 25, 56, 100, 137, 146, 999, 1284, 4663, 5000, 8453, 42161, 42220, 43114,
  59144, 80094, 81457, 534352,
] as const;

export const SIGNER_DEFAULT_CHAIN_ID = 43114;

const MAINNETS = new Set<number>(SIGNER_MAINNET_IDS);

export function isSignerTestnet(chainId: number): boolean {
  return CHAINS[chainId]?.isTestnet === true;
}

export function isSignerMainnet(chainId: number): boolean {
  return MAINNETS.has(chainId) && !isSignerTestnet(chainId);
}

export function signerEnabledByDefault(chainId: number): boolean {
  return chainId === SIGNER_DEFAULT_CHAIN_ID && CHAINS[chainId]?.signerEnabledByDefault === true;
}

export function assertSignerChainCanBeEnabled(chainId: number, label: string): void {
  if (isSignerTestnet(chainId)) {
    throw new EvalancheError(
      `${label}: testnet ${chainId} cannot be enabled on the signer`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  if (!isSignerMainnet(chainId)) {
    throw new EvalancheError(
      `${label}: chain ${chainId} is not one of the signer mainnets`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
}
