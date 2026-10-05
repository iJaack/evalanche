import { createAvalancheClient } from '@avalanche-sdk/client';
import { avalanche, avalancheFuji } from 'viem/chains';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export type AvalancheNetwork = 'avalanche' | 'fuji';

function networkConfig(network: AvalancheNetwork) {
  return network === 'avalanche'
    ? { chain: avalanche, chainId: 43114, hrp: 'avax' as const, networkID: 1 }
    : { chain: avalancheFuji, chainId: 43113, hrp: 'fuji' as const, networkID: 5 };
}

export interface AvalancheValidatorRecord {
  nodeID: string;
  stakeAmount: string;
  startTime: string;
  endTime: string;
  delegationFee?: string;
  uptime?: string;
  connected?: boolean;
}

export interface AvalancheProvider {
  readonly network: AvalancheNetwork;
  readonly chainId: number;
  readonly hrp: 'avax' | 'fuji';
  readonly networkID: number;
  getXBalance(address: string): Promise<bigint>;
  getPBalance(address: string): Promise<bigint>;
  getPStake(address: string): Promise<bigint>;
  getCurrentValidators(): Promise<AvalancheValidatorRecord[]>;
  getMinStake(): Promise<{ minValidatorStake: bigint; minDelegatorStake: bigint }>;
  getAtomicUTXOCount(destination: 'X' | 'P' | 'C', source: 'X' | 'P' | 'C', address: string): Promise<number>;
}

function buildProvider(network: AvalancheNetwork) {
  const config = networkConfig(network);
  const client = createAvalancheClient({
    chain: config.chain,
    transport: { type: 'http' },
  });
  return {
    network,
    chainId: config.chainId,
    hrp: config.hrp,
    networkID: config.networkID,
    getXBalance: async (address: string) => (
      await client.xChain.getBalance({ address, assetID: 'AVAX' })
    ).balance,
    getPBalance: async (address: string) => (
      await client.pChain.getBalance({ addresses: [address] })
    ).balance,
    getPStake: async (address: string) => (
      await client.pChain.getStake({ addresses: [address] })
    ).staked,
    getCurrentValidators: async () => (
      await client.pChain.getCurrentValidators({})
    ).validators,
    getMinStake: async () => client.pChain.getMinStake({}),
    getAtomicUTXOCount: async (
      destination: 'X' | 'P' | 'C',
      source: 'X' | 'P' | 'C',
      address: string,
    ) => {
      const chainClient = destination === 'C'
        ? client.cChain
        : destination === 'P'
          ? client.pChain
          : client.xChain;
      return (await chainClient.getUTXOs({
        addresses: [address],
        sourceChain: source,
      })).utxos.length;
    },
  };
}

const providerCache = new Map<AvalancheNetwork, AvalancheProvider>();

/**
 * Create or retrieve a cached Avalanche client for mainnet or Fuji.
 */
export async function createAvalancheProvider(
  network: AvalancheNetwork,
): Promise<AvalancheProvider> {
  const cached = providerCache.get(network);
  if (cached) return cached;

  try {
    const provider: AvalancheProvider = buildProvider(network);
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
 * Return stable network metadata without making an RPC request.
 */
export function getAvalancheContext(network: AvalancheNetwork) {
  const { chain: _chain, ...context } = networkConfig(network);
  return context;
}

/**
 * Clear the provider cache (useful for testing).
 */
export function clearProviderCache(): void {
  providerCache.clear();
}
