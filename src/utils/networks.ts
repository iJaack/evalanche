/** Network configuration for an Avalanche-compatible chain */
export interface NetworkConfig {
  rpcUrl: string;
  chainId: number;
  name: string;
  explorer: string;
}

/** Pre-configured Avalanche networks */
export const NETWORKS: Record<string, NetworkConfig> = {
  avalanche: {
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    chainId: 43114,
    name: 'Avalanche C-Chain',
    explorer: 'https://snowtrace.io',
  },
  fuji: {
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    chainId: 43113,
    name: 'Avalanche Fuji Testnet',
    explorer: 'https://testnet.snowtrace.io',
  },
};

/** Network specifier: named network or custom config */
export type NetworkOption = 'avalanche' | 'fuji' | { rpcUrl: string; chainId: number };

/**
 * Resolve a network option to a full NetworkConfig.
 * @param network - Named network or custom config
 * @returns Resolved network configuration
 */
export function getNetworkConfig(network: NetworkOption): NetworkConfig {
  if (typeof network === 'string') {
    const config = NETWORKS[network];
    if (!config) {
      throw new Error(`Unknown network: ${network}`);
    }
    return config;
  }
  return {
    rpcUrl: network.rpcUrl,
    chainId: network.chainId,
    name: `Custom (${network.chainId})`,
    explorer: '',
  };
}
