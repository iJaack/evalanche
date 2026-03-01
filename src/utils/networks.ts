import { CHAINS, CHAIN_ALIASES, getChainById, getChainByAlias } from './chains';
import type { ChainConfig } from './chains';

/** Network configuration for an EVM chain */
export interface NetworkConfig {
  rpcUrl: string;
  chainId: number;
  name: string;
  explorer: string;
}

/** Named chain aliases accepted as network option strings */
export type ChainName =
  | 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'bsc'
  | 'avalanche' | 'fuji' | 'fantom' | 'gnosis' | 'zksync' | 'linea'
  | 'scroll' | 'blast' | 'mantle' | 'celo' | 'moonbeam' | 'cronos'
  | 'berachain' | 'sepolia' | 'base-sepolia';

/** Network specifier: named chain, custom config, or chain ID */
export type NetworkOption =
  | ChainName
  | { rpcUrl: string; chainId: number; name?: string; explorer?: string };

/** Pre-configured networks (legacy compat — use CHAINS from chains.ts for full registry) */
export const NETWORKS: Record<string, NetworkConfig> = {};
for (const [alias, chainId] of Object.entries(CHAIN_ALIASES)) {
  const chain = CHAINS[chainId];
  if (chain) {
    NETWORKS[alias] = {
      rpcUrl: chain.rpc[0],
      chainId: chain.id,
      name: chain.name,
      explorer: chain.explorer,
    };
  }
}

/**
 * Resolve a network option to a full NetworkConfig.
 * Accepts named aliases (e.g. 'ethereum', 'base', 'arbitrum') or custom config objects.
 * @param network - Named network or custom config
 * @returns Resolved network configuration
 */
export function getNetworkConfig(network: NetworkOption): NetworkConfig {
  if (typeof network === 'string') {
    const config = NETWORKS[network];
    if (!config) {
      throw new Error(`Unknown network: ${network}. Supported: ${Object.keys(CHAIN_ALIASES).join(', ')}`);
    }
    return config;
  }
  return {
    rpcUrl: network.rpcUrl,
    chainId: network.chainId,
    name: network.name ?? `Custom (${network.chainId})`,
    explorer: network.explorer ?? '',
  };
}

/**
 * Get the ChainConfig for a NetworkOption, if available in the registry.
 * Returns undefined for custom networks not in the registry.
 */
export function getChainConfigForNetwork(network: NetworkOption): ChainConfig | undefined {
  if (typeof network === 'string') {
    return getChainByAlias(network);
  }
  return getChainById(network.chainId);
}
