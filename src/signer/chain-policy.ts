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
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { LIFI_DIAMOND, NATIVE_ADDRESS } from './decode';
import {
  SIGNER_DEFAULT_CHAIN_ID,
  assertSignerChainCanBeEnabled,
  isSignerTestnet,
} from './chain-registry';
import type { ClmmModuleConfig } from './clmm';
import type { PolymarketModuleConfig } from './polymarket-module';

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
   * USD prices for this chain only. Keys are addresses or "native".
   * They are not shared with another chain.
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
  sanitySource?: string;
  polymarket?: PolymarketModuleConfig;
  clmm?: ClmmModuleConfig;
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
  };
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
    sanitySource: assertHttps(entry.price?.sanitySource, `${label}.price.sanitySource`) ?? base.sanitySource,
    polymarket: entry.polymarket,
    clmm: entry.clmm,
  };
  if (next.maxFeeUsd !== undefined && (!Number.isFinite(next.maxFeeUsd) || next.maxFeeUsd < 0)) {
    fail(`${label}.gas.maxFeeUsd must be a non-negative number`);
  }
  assertSlippage(next.slippageCaps, `${label}.slippageCaps`);
  if (next.priceIds) {
    for (const [key, value] of Object.entries(next.priceIds)) {
      if (typeof value !== 'string' || value.length === 0) fail(`${label}.price.ids values must be strings`);
      if (key !== 'native') checksum(key, `${label}.price.ids`);
    }
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
