import { safeFetch } from '../utils/safe-fetch';
import type { NetworkOption } from '../utils/networks';
import type { ChainConfig } from '../utils/chains';

const DATA_API = 'https://data-api.avax.network';
const PRIMARY_SUBNET = '11111111111111111111111111111111LpoYY';

export interface AvalancheL1 {
  chainId: number;
  name: string;
  blockchainId: string;
  subnetId: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: ChainConfig['currency'];
  isTestnet: boolean;
}

export interface AvalancheL1Options {
  network?: 'mainnet' | 'fuji';
  /** Optional AvaCloud key for higher rate limits; never sent to an L1 RPC. */
  apiKey?: string;
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Discover public EVM L1s from Avalanche's live catalog, without a static allowlist. */
export async function listAvalancheL1s(options: AvalancheL1Options = {}): Promise<AvalancheL1[]> {
  const network = options.network ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'fuji') throw new Error('Expected mainnet or fuji');
  const response = await safeFetch(`${DATA_API}/v1/chains?network=${network}`, {
    headers: options.apiKey ? { 'x-glacier-api-key': options.apiKey } : undefined,
  });
  if (!response.ok) throw new Error(`Avalanche catalog returned HTTP ${response.status}`);
  const data = await response.json() as { chains?: unknown[] };
  if (!Array.isArray(data.chains)) throw new Error('Invalid Avalanche chain catalog');
  const result: AvalancheL1[] = [];
  const seen = new Set<number>();
  for (const item of data.chains) {
    if (!item || typeof item !== 'object') throw new Error('Invalid Avalanche chain metadata');
    const chain = item as Record<string, unknown>;
    if (chain.vmName !== 'EVM' || chain.private === true || chain.status !== 'OK' ||
        chain.subnetId === PRIMARY_SUBNET || !chain.subnetId || !chain.platformChainId) continue;
    if (chain.isTestnet !== (network === 'fuji')) continue;
    const id = typeof chain.chainId === 'string' && /^\d+$/.test(chain.chainId) ? Number(chain.chainId) : NaN;
    const token = chain.networkToken as Record<string, unknown> | undefined;
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) ||
        typeof chain.chainName !== 'string' || typeof chain.subnetId !== 'string' ||
        typeof chain.platformChainId !== 'string' || !httpUrl(chain.rpcUrl) ||
        !httpUrl(chain.explorerUrl) || !token || typeof token.name !== 'string' ||
        typeof token.symbol !== 'string' || token.decimals !== 18) {
      throw new Error('Invalid or unsupported Avalanche EVM L1 metadata');
    }
    seen.add(id);
    result.push({ chainId: id, name: chain.chainName, blockchainId: chain.platformChainId,
      subnetId: chain.subnetId, rpcUrl: chain.rpcUrl, explorer: chain.explorerUrl,
      nativeCurrency: { name: token.name, symbol: token.symbol, decimals: 18 },
      isTestnet: chain.isTestnet as boolean });
  }
  return result;
}

/** Build a custom L1 network only after its RPC confirms the expected EVM chain ID. */
export async function getAvalancheL1Network(
  chainId: number,
  options: AvalancheL1Options & { rpcUrl?: string } = {},
): Promise<Exclude<NetworkOption, string>> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid L1 chain ID');
  const chain = (await listAvalancheL1s(options)).find((item) => item.chainId === chainId);
  if (!chain) throw new Error(`Avalanche L1 ${chainId} is not in the public ${options.network ?? 'mainnet'} catalog`);
  const rpcUrl = options.rpcUrl ?? chain.rpcUrl;
  if (!httpUrl(rpcUrl)) throw new Error('Invalid L1 RPC URL');
  const response = await safeFetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
  if (!response.ok) throw new Error(`L1 RPC returned HTTP ${response.status}`);
  const reply = await response.json() as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };
  if (reply.error || reply.jsonrpc !== '2.0' || reply.id !== 1 || typeof reply.result !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(reply.result) || BigInt(reply.result) !== BigInt(chainId)) {
    throw new Error(`L1 RPC chain ID mismatch for ${chainId}`);
  }
  return { chainId, rpcUrl, name: chain.name, explorer: chain.explorer,
    nativeCurrency: chain.nativeCurrency, isTestnet: chain.isTestnet };
}
