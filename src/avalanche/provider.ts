import { Avalanche } from '@avalabs/core-wallets-sdk';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Avalanche provider wrapping core-wallets-sdk JsonRpcProvider */
export type AvalancheProvider = InstanceType<typeof Avalanche.JsonRpcProvider>;

// Cache providers by network
const providerCache = new Map<string, AvalancheProvider>();

/**
 * Create or retrieve a cached Avalanche provider.
 * Uses core-wallets-sdk's JsonRpcProvider which exposes PVM, AVM, EVM APIs.
 * @param network - 'avalanche' for mainnet, 'fuji' for testnet
 * @returns Avalanche JSON-RPC provider
 */
export async function createAvalancheProvider(
  network: 'avalanche' | 'fuji',
): Promise<AvalancheProvider> {
  const cached = providerCache.get(network);
  if (cached) return cached;

  try {
    // These are async factory methods that fetch context from the network
    const provider =
      network === 'avalanche'
        ? Avalanche.JsonRpcProvider.getDefaultMainnetProvider()
        : Avalanche.JsonRpcProvider.getDefaultFujiProvider();

    providerCache.set(network, provider);
    return provider;
  } catch (error) {
    throw new EvalancheError(
      `Failed to create Avalanche provider for ${network}`,
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Get the Avalanche context (network IDs, chain IDs, asset IDs) for the given network.
 * @param network - 'avalanche' for mainnet, 'fuji' for testnet
 */
export function getAvalancheContext(
  network: 'avalanche' | 'fuji',
): typeof Avalanche.MainnetContext {
  return network === 'avalanche'
    ? Avalanche.MainnetContext
    : Avalanche.FujiContext;
}

/**
 * Clear the provider cache (useful for testing).
 */
export function clearProviderCache(): void {
  providerCache.clear();
}
