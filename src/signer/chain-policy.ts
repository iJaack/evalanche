/**
 * Resolves signer chain config.
 *
 * An old single-chain file (chainId / chainIds, one rpcUrl, address-keyed
 * tokenCaps, one maxGasCostWei, one priceSourceUrl) keeps the same effective
 * policy. The `chains` object is the per-chain form: enabled defaults to
 * false except Avalanche 43114, and a kill switch turns a chain off without
 * a code change. Address-keyed caps and the global price map stay on the old
 * file. They are not copied onto chains.
 */

import { getAddress } from 'ethers';
import { SOLANA_CLUSTERS, type SolanaChainId } from './solana-intent';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { LIFI_DIAMOND, NATIVE_ADDRESS } from './decode';
import { nativeCoinGeckoId, normalizeCoinGeckoFeed, type CoinGeckoPriceBound, type CoinGeckoPriceFeed } from './price-feed';
import {
  SIGNER_DEFAULT_CHAIN_ID,
  assertSignerChainCanBeEnabled,
  isSignerTestnet,
} from './chain-registry';
import type { ClmmModuleConfig } from './clmm';
import type { DexVenueConfig } from './dex-venue';
import type { PolymarketModuleConfig } from './polymarket-module';
import type { CctpConfig } from './cctp';
import type { RevokeOnlyConfig } from './revoke-only';

export interface SlippageInput {
  stables?: string[];
  top?: string[];
  stableBps?: number;
  topBps?: number;
  otherBps?: number;
}

export type GasMode = 'legacy' | 'eip1559' | 'both';

export interface ChainGasConfig {
  /** legacy = type 0, eip1559 = type 2, both = the historical default. */
  mode?: GasMode;
  /** Max gas cost in native wei (gasLimit × price). */
  maxFeeWei?: string;
  /**
   * USD cap on that same gas cost. Required and positive for every enabled
   * chain when `chains` is set. An old file without `chains` leaves it unset.
   */
  maxFeeUsd?: number;
}

export interface ChainPriceConfig {
  /** Address, or "native", to a price id. The sanity source is keyed by address. */
  ids?: Record<string, string>;
  /** HTTPS feed of address → USD. Replaces priceSourceUrl for this chain. */
  sanitySource?: string;
  /**
   * CoinGecko `simple/price` feed. Static `prices` may be omitted when this
   * is set. `ids` map an address, or `native`, to a CoinGecko coin id.
   * The native id defaults from the chain when `ids` omits it.
   */
  priceFeed?: 'coingecko' | { provider?: string; url?: string; maxAgeMs?: number };
  /**
   * Inclusive USD min/max for a CoinGecko price. Keys are addresses or "native".
   * A feed price outside the band is refused. `min` is positive.
   */
  bounds?: Record<string, { min: number; max: number }>;
  /**
   * USD prices for this chain only. Keys are addresses or "native".
   * They are not shared with another chain. A positive value is also the
   * ±50% reference for a CoinGecko price of that asset.
   */
  prices?: Record<string, number>;
}

export interface SignerChainConfig {
  /** Default false, except 43114 when the key is present or implied. */
  enabled?: boolean;
  /** Per-chain kill switch. Wins over enabled. */
  killSwitch?: boolean;
  rpcUrls?: string[];
  gas?: ChainGasConfig;
  tokenCaps?: Record<string, string>;
  slippageCaps?: SlippageInput;
  lifiDiamond?: string;
  /** Selectors the Li.Fi diamond on this chain may use. Absent = allow map only. */
  lifiSelectors?: string[];
  kyberExecutors?: string[];
  price?: ChainPriceConfig;
  polymarket?: PolymarketModuleConfig;
  clmm?: ClmmModuleConfig;
  /** Direct router venue. Off unless enabled. See docs/signer-multichain.md. */
  dex?: DexVenueConfig;
  /** Zero-approval and setApprovalForAll(false) only. Off unless enabled. */
  revokeOnly?: RevokeOnlyConfig;
  /** CCTP V2 burn on Avalanche and receive on Polygon. Off unless enabled. */
  cctp?: CctpConfig;
}

export interface SignerConfigInput {
  chainId?: number;
  chainIds?: number[];
  rpcUrl?: string;
  rpcUrls?: Record<string, string[]>;
  tokenCaps?: Record<string, unknown>;
  maxGasCostWei?: string;
  slippageCaps?: SlippageInput;
  kyberExecutors?: string[];
  priceSourceUrl?: string;
  /** Legacy file only. Not copied onto `chains`. */
  priceFeed?: 'coingecko' | { provider?: string; url?: string; maxAgeMs?: number };
  chains?: Record<string, SignerChainConfig>;
}

export interface ResolvedChain {
  chainId: number;
  enabled: boolean;
  rpcUrls: string[];
  gasMode: GasMode;
  maxFeeWei: bigint;
  maxFeeUsd?: number;
  tokenCaps: Record<string, string>;
  slippageCaps?: SlippageInput;
  /** Avalanche stable/top defaults apply. True for 43114 and for legacy config. */
  avalancheSlippageDefaults: boolean;
  lifiDiamond: string;
  lifiSelectors?: string[];
  /** Undefined keeps the Avalanche executor default. An empty list allows none. */
  kyberExecutors?: string[];
  priceIds?: Record<string, string>;
  /** Lowercase address → USD. Present only for this chain. */
  localPrices?: Record<string, number>;
  /** Lowercase address → inclusive USD band for a CoinGecko price. */
  priceBounds?: Record<string, CoinGeckoPriceBound>;
  sanitySource?: string;
  priceFeed?: CoinGeckoPriceFeed;
  polymarket?: PolymarketModuleConfig;
  clmm?: ClmmModuleConfig;
  dex?: DexVenueConfig;
  revokeOnly?: RevokeOnlyConfig;
  cctp?: CctpConfig;
}

export interface SignerPolicy {
  /** True when the file has no `chains` object. */
  legacy: boolean;
  /** Address-keyed caps from an old file. Shared across that file's chains. */
  legacyCaps: Record<string, string>;
  chains: Map<number, ResolvedChain>;
  enabled: number[];
}

export interface GasCapBounds {
  defaultMaxFeeWei: bigint;
  hardMaxFeeWei: bigint;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}

function chainKey(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function isAddressKeyedCaps(caps: Record<string, unknown>): boolean {
  return Object.values(caps).every((value) => typeof value === 'string');
}

function isChainKeyedCaps(caps: Record<string, unknown>): boolean {
  const keys = Object.keys(caps);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    if (chainKey(key) === null) return false;
    const value = caps[key];
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  });
}

function parseFee(value: string | undefined, fallback: bigint, hard: bigint, label: string): bigint {
  if (value === undefined) return fallback;
  if (!DECIMAL.test(value)) fail(`${label} must be a decimal string`);
  const parsed = BigInt(value);
  if (parsed > hard) fail(`${label} cannot exceed the hard gas-cost cap`);
  return parsed;
}

function checksum(address: string, label: string): string {
  try {
    return getAddress(address);
  } catch {
    fail(`${label} is not an address`);
  }
}

function normalizeLocalPrices(
  prices: Record<string, number> | undefined,
  label: string,
): Record<string, number> | undefined {
  if (prices === undefined) return undefined;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) fail(`${label} must be an address map`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(prices)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`${label} values must be non-negative numbers`);
    }
    if (key === 'native') {
      out[NATIVE_ADDRESS.toLowerCase()] = value;
      continue;
    }
    out[checksum(key, label).toLowerCase()] = value;
  }
  return out;
}

function normalizePriceBounds(
  bounds: Record<string, { min: number; max: number }> | undefined,
  label: string,
): Record<string, CoinGeckoPriceBound> | undefined {
  if (bounds === undefined) return undefined;
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) fail(`${label} must be an address map`);
  const out: Record<string, CoinGeckoPriceBound> = {};
  for (const [key, value] of Object.entries(bounds)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} values must be { min, max }`);
    const { min, max } = value;
    const minMicros = Math.round(min * 1_000_000);
    const maxMicros = Math.round(max * 1_000_000);
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)
      || !(min > 0) || max < min || !Number.isSafeInteger(minMicros) || !Number.isSafeInteger(maxMicros)) {
      fail(`${label} min must be positive and max must be at least min`);
    }
    const address = key === 'native' ? NATIVE_ADDRESS.toLowerCase() : checksum(key, label).toLowerCase();
    out[address] = { min, max };
  }
  return out;
}

function normalizeCaps(caps: Record<string, string> | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(caps ?? {})) {
    if (typeof value !== 'string' || !DECIMAL.test(value)) fail(`${label} values must be decimal strings`);
    if (key === 'native') {
      out.native = value;
      continue;
    }
    out[checksum(key, label)] = value;
  }
  return out;
}

function normalizeSelectors(list: string[] | undefined, label: string): string[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length === 0) fail(`${label} must be a non-empty selector list`);
  return list.map((selector) => {
    const normalized = selector.toLowerCase();
    if (!/^0x[0-9a-f]{8}$/.test(normalized)) fail(`${label} has an invalid selector`);
    return normalized;
  });
}

function normalizeExecutors(list: string[] | undefined, label: string): string[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) fail(`${label} must be an address list`);
  return list.map((address) => checksum(address, label));
}

function normalizeUrls(list: string[] | undefined, label: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((url) => typeof url !== 'string' || url.trim().length === 0)) {
    fail(`${label} must be a list of URLs`);
  }
  return list.map((url) => url.trim());
}

function assertHttps(url: string | undefined, label: string): string | undefined {
  if (url === undefined) return undefined;
  if (!url.startsWith('https://')) fail(`${label} must be https`);
  return url;
}

function assertGasMode(mode: GasMode | undefined, label: string): GasMode {
  if (mode === undefined) return 'both';
  if (mode !== 'legacy' && mode !== 'eip1559' && mode !== 'both') fail(`${label} mode is invalid`);
  return mode;
}

function assertSlippage(caps: SlippageInput | undefined, label: string): void {
  if (!caps) return;
  for (const name of ['stableBps', 'topBps', 'otherBps'] as const) {
    const value = caps[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      fail(`${label}.${name} must be an integer from 0 to 10000`);
    }
  }
  for (const name of ['stables', 'top'] as const) {
    const list = caps[name];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(`${label}.${name} must be an address list`);
    for (const address of list) checksum(address, `${label}.${name}`);
  }
}

function legacyChainIds(config: SignerConfigInput): number[] {
  const listed = config.chainIds ?? (config.chainId !== undefined ? [config.chainId] : []);
  const out: number[] = [];
  for (const id of listed) {
    if (!Number.isSafeInteger(id)) fail('chainId must be an integer');
    if (isSignerTestnet(id)) {
      fail(`testnet ${id} cannot be enabled on the signer`);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function blankChain(
  chainId: number,
  bounds: GasCapBounds,
  caps: Record<string, string>,
  config: SignerConfigInput,
  legacy: boolean,
): ResolvedChain {
  const globalFee = parseFee(config.maxGasCostWei, bounds.defaultMaxFeeWei, bounds.hardMaxFeeWei, 'maxGasCostWei');
  return {
    chainId,
    enabled: true,
    rpcUrls: config.rpcUrl ? [config.rpcUrl] : [],
    gasMode: 'both',
    maxFeeWei: globalFee,
    tokenCaps: caps,
    slippageCaps: config.slippageCaps,
    avalancheSlippageDefaults: legacy || chainId === SIGNER_DEFAULT_CHAIN_ID,
    lifiDiamond: LIFI_DIAMOND,
    kyberExecutors: legacy || chainId === SIGNER_DEFAULT_CHAIN_ID ? config.kyberExecutors : config.kyberExecutors,
    sanitySource: legacy ? config.priceSourceUrl : undefined,
    priceFeed: legacy ? normalizeCoinGeckoFeed(config.priceFeed, 'priceFeed') : undefined,
  };
}

const CHAIN_KEYS = new Set([
  'enabled', 'killSwitch', 'rpcUrls', 'gas', 'tokenCaps', 'slippageCaps', 'lifiDiamond',
  'lifiSelectors', 'kyberExecutors', 'price', 'polymarket', 'clmm', 'dex', 'revokeOnly', 'cctp',
]);
const GAS_KEYS = new Set(['mode', 'maxFeeWei', 'maxFeeUsd']);
const PRICE_KEYS = new Set(['ids', 'sanitySource', 'priceFeed', 'bounds', 'prices']);
const SLIPPAGE_KEYS = new Set(['stables', 'top', 'stableBps', 'topBps', 'otherBps']);
const FEED_KEYS = new Set(['provider', 'url', 'maxAgeMs']);
const BOUND_KEYS = new Set(['min', 'max']);

function assertKnownKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not a recognized setting`);
  }
}

function applyChainEntry(
  base: ResolvedChain,
  entry: SignerChainConfig,
  config: SignerConfigInput,
  bounds: GasCapBounds,
  perChainCaps: Record<string, string> | undefined,
): ResolvedChain {
  const id = base.chainId;
  const label = `chains.${id}`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} must be an object`);
  assertKnownKeys(entry, CHAIN_KEYS, label);
  if (entry.gas !== undefined) {
    if (entry.gas === null || typeof entry.gas !== 'object' || Array.isArray(entry.gas)) fail(`${label}.gas must be an object`);
    assertKnownKeys(entry.gas, GAS_KEYS, `${label}.gas`);
  }
  if (entry.price !== undefined) {
    if (entry.price === null || typeof entry.price !== 'object' || Array.isArray(entry.price)) fail(`${label}.price must be an object`);
    assertKnownKeys(entry.price, PRICE_KEYS, `${label}.price`);
    const feed = entry.price.priceFeed;
    if (feed !== undefined && typeof feed === 'object' && feed !== null) {
      assertKnownKeys(feed, FEED_KEYS, `${label}.price.priceFeed`);
    }
    for (const [key, bound] of Object.entries(entry.price.bounds ?? {})) {
      if (bound === null || typeof bound !== 'object' || Array.isArray(bound)) fail(`${label}.price.bounds.${key} must be an object`);
      assertKnownKeys(bound, BOUND_KEYS, `${label}.price.bounds.${key}`);
    }
  }
  if (entry.slippageCaps !== undefined) {
    if (entry.slippageCaps === null || typeof entry.slippageCaps !== 'object' || Array.isArray(entry.slippageCaps)) {
      fail(`${label}.slippageCaps must be an object`);
    }
    assertKnownKeys(entry.slippageCaps, SLIPPAGE_KEYS, `${label}.slippageCaps`);
  }
  const rpcUrls = entry.rpcUrls ?? config.rpcUrls?.[String(id)];
  const next: ResolvedChain = {
    ...base,
    rpcUrls: rpcUrls ? normalizeUrls(rpcUrls, `${label}.rpcUrls`) : base.rpcUrls,
    gasMode: assertGasMode(entry.gas?.mode, `${label}.gas`),
    maxFeeWei: parseFee(entry.gas?.maxFeeWei, base.maxFeeWei, bounds.hardMaxFeeWei, `${label}.gas.maxFeeWei`),
    maxFeeUsd: entry.gas?.maxFeeUsd,
    tokenCaps: perChainCaps ?? (entry.tokenCaps ? normalizeCaps(entry.tokenCaps, `${label}.tokenCaps`) : base.tokenCaps),
    slippageCaps: entry.slippageCaps ?? base.slippageCaps,
    avalancheSlippageDefaults: id === SIGNER_DEFAULT_CHAIN_ID,
    lifiDiamond: entry.lifiDiamond ? checksum(entry.lifiDiamond, `${label}.lifiDiamond`) : base.lifiDiamond,
    lifiSelectors: normalizeSelectors(entry.lifiSelectors, `${label}.lifiSelectors`),
    kyberExecutors: entry.kyberExecutors !== undefined
      ? normalizeExecutors(entry.kyberExecutors, `${label}.kyberExecutors`)
      : (id === SIGNER_DEFAULT_CHAIN_ID ? base.kyberExecutors : entry.kyberExecutors),
    priceIds: entry.price?.ids,
    localPrices: normalizeLocalPrices(entry.price?.prices, `${label}.price.prices`) ?? base.localPrices,
    priceBounds: normalizePriceBounds(entry.price?.bounds, `${label}.price.bounds`) ?? base.priceBounds,
    sanitySource: assertHttps(entry.price?.sanitySource, `${label}.price.sanitySource`) ?? base.sanitySource,
    priceFeed: entry.price?.priceFeed !== undefined
      ? normalizeCoinGeckoFeed(entry.price.priceFeed, `${label}.price.priceFeed`)
      : base.priceFeed,
    polymarket: entry.polymarket,
    clmm: entry.clmm,
    dex: entry.dex,
    revokeOnly: entry.revokeOnly,
    cctp: entry.cctp,
  };
  if (next.maxFeeUsd !== undefined && (!Number.isFinite(next.maxFeeUsd) || next.maxFeeUsd < 0)) {
    fail(`${label}.gas.maxFeeUsd must be a non-negative number`);
  }
  assertSlippage(next.slippageCaps, `${label}.slippageCaps`);
  if (next.priceFeed && next.sanitySource) {
    fail(`${label}.price sets priceFeed and sanitySource`);
  }
  if (next.priceIds) {
    for (const [key, value] of Object.entries(next.priceIds)) {
      if (typeof value !== 'string' || value.length === 0) fail(`${label}.price.ids values must be strings`);
      if (key !== 'native') checksum(key, `${label}.price.ids`);
      if (next.priceFeed && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
        fail(`${label}.price.ids values must be CoinGecko coin ids`);
      }
    }
  }
  if (next.priceFeed && !nativeCoinGeckoId(id, next.priceIds) && next.localPrices?.[NATIVE_ADDRESS.toLowerCase()] === undefined) {
    fail(`${label}.price.priceFeed needs a native coin id`);
  }
  if (id !== SIGNER_DEFAULT_CHAIN_ID && entry.kyberExecutors === undefined && !config.chains) {
    next.kyberExecutors = base.kyberExecutors;
  }
  return next;
}

export function resolveSignerPolicy(config: SignerConfigInput, bounds: GasCapBounds): SignerPolicy {
  if (config.priceSourceUrl && !config.priceSourceUrl.startsWith('https://')) {
    fail('Price source URL must be https');
  }
  if (config.priceFeed && config.priceSourceUrl) {
    fail('set priceFeed or priceSourceUrl, not both');
  }
  if (!config.chains && config.priceFeed) normalizeCoinGeckoFeed(config.priceFeed, 'priceFeed');
  assertSlippage(config.slippageCaps, 'slippageCaps');
  const rawCaps = config.tokenCaps ?? {};
  const chainKeyed = isChainKeyedCaps(rawCaps);
  const addressKeyed = isAddressKeyedCaps(rawCaps);
  if (!chainKeyed && !addressKeyed) fail('tokenCaps must be an address map or a chainId map');
  if (chainKeyed && config.chains && Object.values(config.chains).some((entry) => entry.tokenCaps)) {
    fail('tokenCaps cannot be set both as tokenCaps{chainId} and chains[chainId].tokenCaps');
  }
  const legacyCaps = addressKeyed ? normalizeCaps(rawCaps as Record<string, string>, 'tokenCaps') : {};
  const capsByChain = new Map<number, Record<string, string>>();
  if (chainKeyed) {
    for (const [key, value] of Object.entries(rawCaps)) {
      const id = chainKey(key)!;
      capsByChain.set(id, normalizeCaps(value as Record<string, string>, `tokenCaps.${id}`));
    }
  }

  const legacy = config.chains === undefined;
  if (!legacy && addressKeyed && Object.keys(rawCaps).length > 0) {
    fail('address-keyed tokenCaps cannot be shared across chains; set a cap on each chain');
  }
  const enabled = new Set<number>();
  if (legacy) {
    for (const id of legacyChainIds(config)) enabled.add(id);
  } else {
    enabled.add(SIGNER_DEFAULT_CHAIN_ID);
    for (const key of Object.keys(config.chains ?? {})) {
      const id = chainKey(key);
      if (id === null) fail(`chains.${key} is not a chain id`);
      assertSignerChainCanBeEnabled(id, `chains.${key}`);
      const entry = config.chains?.[key] ?? {};
      if (entry.killSwitch === true || entry.enabled === false) {
        enabled.delete(id);
        continue;
      }
      if (id === SIGNER_DEFAULT_CHAIN_ID || entry.enabled === true) enabled.add(id);
    }
    const avalanche = config.chains?.[String(SIGNER_DEFAULT_CHAIN_ID)];
    if (avalanche?.killSwitch === true || avalanche?.enabled === false) enabled.delete(SIGNER_DEFAULT_CHAIN_ID);
  }

  for (const id of capsByChain.keys()) {
    if (!legacy && !config.chains?.[String(id)] && id !== SIGNER_DEFAULT_CHAIN_ID) {
      assertSignerChainCanBeEnabled(id, `tokenCaps.${id}`);
    }
  }

  const chains = new Map<number, ResolvedChain>();
  const known = new Set<number>([...enabled, ...capsByChain.keys()]);
  if (!legacy) {
    for (const key of Object.keys(config.chains ?? {})) {
      const id = chainKey(key);
      if (id !== null) known.add(id);
    }
  }
  for (const id of known) {
    if (isSignerTestnet(id)) fail(`testnet ${id} cannot be enabled on the signer`);
    const entry = config.chains?.[String(id)];
    const sharedCaps = chainKeyed
      ? (capsByChain.get(id) ?? {})
      : (legacy ? legacyCaps : {});
    let resolved = blankChain(id, bounds, sharedCaps, config, legacy);
    if (chainKeyed) resolved.tokenCaps = capsByChain.get(id) ?? {};
    if (entry) resolved = applyChainEntry(resolved, entry, config, bounds, chainKeyed ? capsByChain.get(id) : undefined);
    else if (config.rpcUrls?.[String(id)]) resolved.rpcUrls = normalizeUrls(config.rpcUrls[String(id)], `rpcUrls.${id}`);
    resolved.enabled = enabled.has(id);
    if (!legacy && id !== SIGNER_DEFAULT_CHAIN_ID && entry?.kyberExecutors === undefined) {
      resolved.kyberExecutors = [];
    }
    chains.set(id, resolved);
  }

  return {
    legacy,
    legacyCaps,
    chains,
    enabled: [...enabled],
  };
}

export function tokenCap(chain: ResolvedChain, address: string): string | undefined {
  if (address === 'native') return chain.tokenCaps.native;
  let key: string;
  try {
    key = getAddress(address);
  } catch {
    return undefined;
  }
  return chain.tokenCaps[key] ?? chain.tokenCaps[key.toLowerCase()];
}

/** URLs simulation may use for this chain, in order. */
export function rpcUrlsFor(chain: ResolvedChain): string[] {
  return chain.rpcUrls;
}

/** PR1 accepts only flags. Readiness and signing configuration belong to later PRs. */
export interface SolanaPolicyInput {
  enabled?: boolean;
  clusters?: Partial<Record<SolanaChainId, { enabled?: boolean; killSwitch?: boolean }>>;
}

export interface ResolvedSolanaPolicy {
  enabled: boolean;
  clusters: Record<SolanaChainId, { enabled: boolean; killSwitch: boolean }>;
  effective: SolanaChainId[];
}

function solanaObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`${label}.${String(key)} is not a recognized setting`);
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(`${label}.${key} must be a data field`);
  }
  return value as Record<string, unknown>;
}

function solanaFlag(record: Record<string, unknown>, key: string, label: string): boolean {
  if (!Object.hasOwn(record, key)) return false;
  if (typeof record[key] !== 'boolean') fail(`${label}.${key} must be boolean`);
  return record[key] as boolean;
}

/** Resolve the Solana object independently of EVM defaults; a kill switch always wins. */
export function resolveSolanaPolicy(value: unknown): ResolvedSolanaPolicy {
  const record = value === undefined ? {} : solanaObject(value, ['enabled', 'clusters'], 'solana');
  const enabled = solanaFlag(record, 'enabled', 'solana');
  const input = Object.hasOwn(record, 'clusters') ? solanaObject(record.clusters, SOLANA_CLUSTERS, 'solana.clusters') : {};
  const clusters: ResolvedSolanaPolicy['clusters'] = {
    'solana:mainnet': { enabled: false, killSwitch: false },
    'solana:devnet': { enabled: false, killSwitch: false },
  };
  const effective: SolanaChainId[] = [];
  for (const cluster of SOLANA_CLUSTERS) {
    const entry = Object.hasOwn(input, cluster) ? solanaObject(input[cluster], ['enabled', 'killSwitch'], `solana.clusters.${cluster}`) : {};
    clusters[cluster] = { enabled: solanaFlag(entry, 'enabled', cluster), killSwitch: solanaFlag(entry, 'killSwitch', cluster) };
    if (enabled && clusters[cluster].enabled && !clusters[cluster].killSwitch) effective.push(cluster);
  }
  return { enabled, clusters, effective };
}
