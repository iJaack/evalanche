/**
 * Comprehensive EVM chain registry.
 *
 * Routescan RPCs are preferred where available, with public fallback RPCs.
 * Chain data sourced from Rabby wallet's chain list and Routescan's RPC catalog.
 */

/** Configuration for a supported EVM chain */
export interface ChainConfig {
  /** Chain ID (e.g. 1 for Ethereum) */
  id: number;
  /** Human-readable name (e.g. "Ethereum") */
  name: string;
  /** Short name / alias (e.g. "eth") */
  shortName: string;
  /** Native currency */
  currency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  /** RPC URLs (Routescan first where available, then public fallback) */
  rpc: string[];
  /** Primary block explorer URL */
  explorer: string;
  /** Routescan explorer URL (if supported) */
  routescanExplorer?: string;
  /** Li.Fi chain key for bridging */
  lifiChainKey?: string;
  /** Whether this is a testnet */
  isTestnet?: boolean;
}

/** Routescan RPC URL pattern */
function routescanRpc(chainId: number): string {
  return `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/rpc`;
}

/** Routescan testnet RPC URL pattern */
function routescanTestnetRpc(chainId: number): string {
  return `https://api.routescan.io/v2/network/testnet/evm/${chainId}/rpc`;
}

/** All supported chains keyed by chain ID */
export const CHAINS: Record<number, ChainConfig> = {
  // ── Mainnets ──────────────────────────────────────────────

  1: {
    id: 1,
    name: 'Ethereum',
    shortName: 'eth',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
    explorer: 'https://etherscan.io',
    lifiChainKey: 'ETH',
  },

  10: {
    id: 10,
    name: 'Optimism',
    shortName: 'op',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [routescanRpc(10), 'https://mainnet.optimism.io'],
    explorer: 'https://optimistic.etherscan.io',
    routescanExplorer: 'https://optimism.routescan.io',
    lifiChainKey: 'OPT',
  },

  25: {
    id: 25,
    name: 'Cronos',
    shortName: 'cro',
    currency: { name: 'Cronos', symbol: 'CRO', decimals: 18 },
    rpc: [routescanRpc(25), 'https://evm.cronos.org'],
    explorer: 'https://cronoscan.com',
    routescanExplorer: 'https://cronos.routescan.io',
    lifiChainKey: 'CRO',
  },

  56: {
    id: 56,
    name: 'BNB Smart Chain',
    shortName: 'bsc',
    currency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpc: [routescanRpc(56), 'https://bsc-dataseed.binance.org'],
    explorer: 'https://bscscan.com',
    routescanExplorer: 'https://bsc.routescan.io',
    lifiChainKey: 'BSC',
  },

  100: {
    id: 100,
    name: 'Gnosis',
    shortName: 'gno',
    currency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    rpc: ['https://rpc.gnosischain.com'],
    explorer: 'https://gnosisscan.io',
    lifiChainKey: 'DAI',
  },

  137: {
    id: 137,
    name: 'Polygon',
    shortName: 'matic',
    currency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpc: [routescanRpc(137), 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
    routescanExplorer: 'https://polygon.routescan.io',
    lifiChainKey: 'POL',
  },

  250: {
    id: 250,
    name: 'Fantom',
    shortName: 'ftm',
    currency: { name: 'Fantom', symbol: 'FTM', decimals: 18 },
    rpc: [routescanRpc(250), 'https://rpcapi.fantom.network'],
    explorer: 'https://ftmscan.com',
    routescanExplorer: 'https://fantom.routescan.io',
    lifiChainKey: 'FTM',
  },

  324: {
    id: 324,
    name: 'zkSync Era',
    shortName: 'zksync',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://mainnet.era.zksync.io'],
    explorer: 'https://explorer.zksync.io',
    lifiChainKey: 'ERA',
  },

  1284: {
    id: 1284,
    name: 'Moonbeam',
    shortName: 'glmr',
    currency: { name: 'Glimmer', symbol: 'GLMR', decimals: 18 },
    rpc: ['https://rpc.api.moonbeam.network'],
    explorer: 'https://moonscan.io',
    lifiChainKey: 'MOO',
  },

  5000: {
    id: 5000,
    name: 'Mantle',
    shortName: 'mnt',
    currency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
    rpc: ['https://rpc.mantle.xyz'],
    explorer: 'https://explorer.mantle.xyz',
    lifiChainKey: 'MNT',
  },

  8453: {
    id: 8453,
    name: 'Base',
    shortName: 'base',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [routescanRpc(8453), 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    routescanExplorer: 'https://base.routescan.io',
    lifiChainKey: 'BAS',
  },

  42161: {
    id: 42161,
    name: 'Arbitrum One',
    shortName: 'arb',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [routescanRpc(42161), 'https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    routescanExplorer: 'https://arbitrum.routescan.io',
    lifiChainKey: 'ARB',
  },

  42220: {
    id: 42220,
    name: 'Celo',
    shortName: 'celo',
    currency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
    rpc: ['https://forno.celo.org'],
    explorer: 'https://celoscan.io',
    lifiChainKey: 'CEL',
  },

  43114: {
    id: 43114,
    name: 'Avalanche C-Chain',
    shortName: 'avax',
    currency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpc: [routescanRpc(43114), 'https://api.avax.network/ext/bc/C/rpc'],
    explorer: 'https://snowtrace.io',
    routescanExplorer: 'https://snowtrace.io',
    lifiChainKey: 'AVA',
  },

  59144: {
    id: 59144,
    name: 'Linea',
    shortName: 'linea',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://rpc.linea.build'],
    explorer: 'https://lineascan.build',
    lifiChainKey: 'LNA',
  },

  80094: {
    id: 80094,
    name: 'Berachain',
    shortName: 'bera',
    currency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpc: [routescanRpc(80094), 'https://rpc.berachain.com'],
    explorer: 'https://berascan.com',
    routescanExplorer: 'https://80094.routescan.io',
    lifiChainKey: 'BER',
  },

  81457: {
    id: 81457,
    name: 'Blast',
    shortName: 'blast',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://rpc.blast.io'],
    explorer: 'https://blastscan.io',
    lifiChainKey: 'BLA',
  },

  534352: {
    id: 534352,
    name: 'Scroll',
    shortName: 'scroll',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://rpc.scroll.io'],
    explorer: 'https://scrollscan.com',
    lifiChainKey: 'SCL',
  },

  // ── Testnets ──────────────────────────────────────────────

  43113: {
    id: 43113,
    name: 'Avalanche Fuji Testnet',
    shortName: 'fuji',
    currency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpc: [routescanTestnetRpc(43113), 'https://api.avax-test.network/ext/bc/C/rpc'],
    explorer: 'https://testnet.snowtrace.io',
    isTestnet: true,
  },

  11155111: {
    id: 11155111,
    name: 'Sepolia',
    shortName: 'sep',
    currency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://rpc.sepolia.org'],
    explorer: 'https://sepolia.etherscan.io',
    isTestnet: true,
  },

  84532: {
    id: 84532,
    name: 'Base Sepolia',
    shortName: 'base-sep',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://sepolia.base.org'],
    explorer: 'https://sepolia.basescan.org',
    isTestnet: true,
  },
};

/** Named aliases for chain lookup (used in NetworkOption type) */
export const CHAIN_ALIASES: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
  fuji: 43113,
  fantom: 250,
  gnosis: 100,
  zksync: 324,
  linea: 59144,
  scroll: 534352,
  blast: 81457,
  mantle: 5000,
  celo: 42220,
  moonbeam: 1284,
  cronos: 25,
  berachain: 80094,
  sepolia: 11155111,
  'base-sepolia': 84532,
};

/** All valid chain alias names */
export type ChainAlias = keyof typeof CHAIN_ALIASES;

/**
 * Get the chain config for a chain ID.
 * @param chainId - Numeric chain ID
 * @returns Chain config or undefined if not found
 */
export function getChainById(chainId: number): ChainConfig | undefined {
  return CHAINS[chainId];
}

/**
 * Get the chain config for a named alias.
 * @param alias - Chain alias (e.g. 'ethereum', 'base', 'arbitrum')
 * @returns Chain config or undefined if alias not found
 */
export function getChainByAlias(alias: string): ChainConfig | undefined {
  const chainId = CHAIN_ALIASES[alias];
  if (chainId === undefined) return undefined;
  return CHAINS[chainId];
}

/**
 * Get primary RPC URL for a chain (Routescan first, then public fallback).
 * @param chainId - Numeric chain ID
 * @returns Primary RPC URL
 * @throws If chain ID is not in the registry
 */
export function getPrimaryRpc(chainId: number): string {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unknown chain ID: ${chainId}`);
  }
  return chain.rpc[0];
}

/**
 * Get all supported chain configs.
 * @param includeTestnets - Whether to include testnets (default: true)
 * @returns Array of all chain configs
 */
export function getAllChains(includeTestnets = true): ChainConfig[] {
  return Object.values(CHAINS).filter(c => includeTestnets || !c.isTestnet);
}
