import { createAvalancheClient } from '@avalanche-sdk/client';
import { getUtxoFromBytes } from '@avalanche-sdk/client/utils';
import { avalanche, avalancheFuji } from 'viem/chains';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';

export type AvalancheNetwork = 'avalanche' | 'fuji';

function networkConfig(network: AvalancheNetwork) {
  return network === 'avalanche'
    ? { chain: avalanche, chainId: 43114, hrp: 'avax' as const, networkID: 1 }
    : { chain: avalancheFuji, chainId: 43113, hrp: 'fuji' as const, networkID: 5 };
}

/** AVAX asset IDs on the X-Chain and P-Chain. */
export const AVAX_ASSET_IDS: Record<AvalancheNetwork, string> = {
  avalanche: 'FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z',
  fuji: 'U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK',
};

const DATA_API = 'https://data-api.avax.network';
const UTXO_PAGE_SIZE = 1024;
const MAX_UTXO_PAGES = 100;

type UtxoPage = { numFetched: number | string; utxos: string[]; endIndex?: { address: string; utxo: string } };
type DecodedUtxo = { getAssetId(): string; output: unknown };

/**
 * Sum the AVAX held in hex-encoded UTXOs, unlocked and stakeable-locked alike.
 * Public nodes no longer serve platform.getBalance or avm.getBalance, so balances come from UTXOs.
 */
export function sumAvaxUtxos(
  utxos: readonly string[],
  chainAlias: 'X' | 'P',
  assetId: string,
  decode: (hex: string, chainAlias: 'X' | 'P') => DecodedUtxo = getUtxoFromBytes,
): bigint {
  let total = 0n;
  for (const hex of new Set(utxos)) {
    const utxo = decode(hex, chainAlias);
    if (utxo.getAssetId() !== assetId) continue;
    const output = utxo.output as { amount?: () => bigint; transferOut?: { amount?: () => bigint } };
    if (typeof output.amount === 'function') total += output.amount();
    else if (typeof output.transferOut?.amount === 'function') total += output.transferOut.amount();
  }
  return total;
}

/** Read every UTXO page for an address. */
async function allUtxos(fetchPage: (startIndex?: { address: string; utxo: string }) => Promise<UtxoPage>): Promise<string[]> {
  const utxos: string[] = [];
  let startIndex: { address: string; utxo: string } | undefined;
  for (let page = 0; page < MAX_UTXO_PAGES; page++) {
    const result = await fetchPage(startIndex);
    utxos.push(...result.utxos);
    if (Number(result.numFetched) < UTXO_PAGE_SIZE || !result.endIndex) return utxos;
    startIndex = result.endIndex;
  }
  throw new Error(`More than ${MAX_UTXO_PAGES * UTXO_PAGE_SIZE} UTXOs; refusing to sum a partial balance`);
}

/**
 * Staked AVAX (current and pending) from the Avalanche Data API balances response.
 * Public nodes no longer serve platform.getStake.
 */
export function parseStakedAvax(body: unknown, assetId: string): bigint {
  const balances = (body as { balances?: Record<string, unknown> } | null)?.balances;
  if (!balances || typeof balances !== 'object') throw new Error('Invalid P-Chain balances response');
  let staked = 0n;
  for (const key of ['unlockedStaked', 'lockedStaked', 'pendingStaked']) {
    const entries = balances[key] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Invalid ${key} in P-Chain balances response`);
    for (const entry of entries as Array<{ assetId?: unknown; amount?: unknown }>) {
      if (entry?.assetId === assetId) staked += BigInt(String(entry.amount));
    }
  }
  return staked;
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
    getXBalance: async (address: string) => sumAvaxUtxos(
      await allUtxos((startIndex) => client.xChain.getUTXOs({ addresses: [address], limit: UTXO_PAGE_SIZE, startIndex })),
      'X',
      AVAX_ASSET_IDS[network],
    ),
    getPBalance: async (address: string) => sumAvaxUtxos(
      await allUtxos((startIndex) => client.pChain.getUTXOs({ addresses: [address], limit: UTXO_PAGE_SIZE, startIndex })),
      'P',
      AVAX_ASSET_IDS[network],
    ),
    getPStake: async (address: string) => {
      const dataNetwork = network === 'avalanche' ? 'mainnet' : 'fuji';
      const bech32 = encodeURIComponent(address.replace(/^P-/, ''));
      const response = await safeFetch(
        `${DATA_API}/v1/networks/${dataNetwork}/blockchains/p-chain/balances?addresses=${bech32}`,
      );
      if (!response.ok) throw new Error(`Avalanche Data API returned HTTP ${response.status}`);
      return parseStakedAvax(await response.json(), AVAX_ASSET_IDS[network]);
    },
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
