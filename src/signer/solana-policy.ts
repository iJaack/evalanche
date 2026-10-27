/** Offline Solana configuration and decoded-evidence policy. No custody or RPC. */
import { isAbsolute } from 'node:path';
import { decodeBase58 } from './base58';
import { SOLANA_CLUSTERS, type SolanaChainId } from './solana-intent';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const SOLANA_GENESIS_HASHES = Object.freeze({
  'solana:mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  'solana:devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_PHASE1_PROGRAM_IDS = Object.freeze([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', SYSTEM, TOKEN, TOKEN_2022,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111',
]);
export interface SolanaMintConfig { symbol: string; decimals: number; tokenProgram: string }
export const SOLANA_PHASE1_MAINNET_MINTS = Object.freeze({
  So11111111111111111111111111111111111111112: Object.freeze({ symbol: 'wSOL', decimals: 9, tokenProgram: TOKEN }),
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: Object.freeze({ symbol: 'USDC', decimals: 6, tokenProgram: TOKEN }),
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: Object.freeze({ symbol: 'USDT', decimals: 6, tokenProgram: TOKEN }),
});
export interface SolanaPoolConfig {
  ammProgram: string; pool: string; authority: string; mintA: string; mintB: string; vaultA: string; vaultB: string;
}
export interface SolanaFeesConfig {
  maxComputeUnitLimit?: number;
  maxComputeUnitPriceMicroLamports?: string;
  maxPriorityFeeLamports?: string;
  maxFeeUsd?: string;
}
export interface SolanaPriceConfig {
  ids?: Record<string, string>;
  priceFeed?: { provider?: 'coingecko'; maxAgeMs?: number };
  bounds?: Record<string, { min: number; max: number }>;
  prices?: Record<string, number>;
}
export interface SolanaClusterConfig {
  enabled?: boolean; killSwitch?: boolean;
  rpcUrls?: string[]; rpcQuorum?: 2; rpcTimeoutMs?: number; genesisHash?: string;
  programs?: string[]; innerPrograms?: string[]; mints?: Record<string, SolanaMintConfig>;
  delegates?: string[]; nonceAccounts?: string[]; alt?: { enabled?: false }; allowWsol?: boolean;
  jupiter?: { enabled?: boolean; allowPoolTransfers?: boolean; pools?: SolanaPoolConfig[]; apiBaseUrl?: string };
  fees?: SolanaFeesConfig;
  maxSlippageBps?: number; quoteMaxAgeMs?: number; maxIntentTtlMs?: number;
  maxPerTxUsd?: string; maxRentLamports?: string; tokenCaps?: Record<string, string>; price?: SolanaPriceConfig;
}
export interface SolanaPolicyInput {
  enabled?: boolean;
  /** Path validation only; PR2 never opens this file. */
  secretKeyPath?: string;
  clusters?: Partial<Record<SolanaChainId, SolanaClusterConfig>>;
}
export interface ResolvedSolanaCluster extends SolanaClusterConfig {
  enabled: boolean; killSwitch: boolean; alt: { enabled: false }; allowWsol: boolean;
  jupiter: { enabled: boolean; allowPoolTransfers: boolean; pools: SolanaPoolConfig[]; apiBaseUrl?: string };
  fees: SolanaFeesConfig & { maxFeeUsd: string };
}
export interface ResolvedSolanaConfig {
  enabled: boolean; secretKeyPath?: string;
  clusters: Record<SolanaChainId, ResolvedSolanaCluster>;
}
const CLUSTER_KEYS = ['enabled', 'killSwitch', 'rpcUrls', 'rpcQuorum', 'rpcTimeoutMs', 'genesisHash', 'programs', 'innerPrograms',
  'mints', 'delegates', 'nonceAccounts', 'alt', 'allowWsol', 'jupiter', 'fees', 'maxSlippageBps', 'quoteMaxAgeMs',
  'maxIntentTtlMs', 'maxPerTxUsd', 'maxRentLamports', 'tokenCaps', 'price'];
const POOL_KEYS = ['ammProgram', 'pool', 'authority', 'mintA', 'mintB', 'vaultA', 'vaultB'] as const;

function fail(message: string): never { throw new EvalancheError(`Solana: ${message}`, EvalancheErrorCode.INVALID_CONFIG); }
function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
      || (allowed && !allowed.includes(key))) fail(`unknown or forbidden setting ${String(key)}`);
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(`setting ${key} must be a data field`);
  }
  return value as Record<string, unknown>;
}
function flag(r: Record<string, unknown>, name: string): boolean {
  if (!Object.hasOwn(r, name)) return false;
  if (typeof r[name] !== 'boolean') fail(`${name} must be boolean`);
  return r[name] as boolean;
}
function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${name} is out of range`);
  return value;
}
function decimal(value: unknown, name: string, usd = false): string {
  if (typeof value !== 'string' || !(usd ? /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/ : /^(0|[1-9][0-9]*)$/).test(value)) fail(`${name} must be a canonical decimal string`);
  if (!usd && (value.length > 20 || BigInt(value) > 0xffffffffffffffffn)) fail(`${name} exceeds u64`);
  return value;
}
function key(value: unknown, allowZero = false): string {
  try { decodeBase58(value); } catch { fail('expected canonical base58 32-byte address'); }
  if (!allowZero && value === SYSTEM) fail('zero address is forbidden');
  return value as string;
}
function list(value: unknown, parse: (entry: unknown) => string): string[] {
  if (!Array.isArray(value)) fail('expected an array');
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail('sparse arrays are forbidden');
    result.push(parse(value[i]));
  }
  if (new Set(result).size !== result.length) fail('duplicate entries');
  return result;
}
function https(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value) fail('expected HTTPS URL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('expected HTTPS URL without credentials or fragment');
  } catch { fail('expected HTTPS URL'); }
  return value;
}
function asset(name: string, mints: Record<string, SolanaMintConfig> | undefined): void {
  if (name !== 'native' && !Object.hasOwn(mints ?? {}, name)) fail(`asset ${name} has no configured mint`);
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('price must be positive and finite');
  return value;
}
function priceConfig(value: unknown, mints: SolanaClusterConfig['mints']): SolanaPriceConfig {
  const r = record(value, ['ids', 'priceFeed', 'bounds', 'prices']);
  const result: SolanaPriceConfig = {};
  if (Object.hasOwn(r, 'ids')) {
    result.ids = {};
    for (const [name, id] of Object.entries(record(r.ids))) {
      asset(name, mints);
      if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || (name === 'native' && id !== 'solana')) fail('invalid price id');
      result.ids[name] = id;
    }
  }
  if (Object.hasOwn(r, 'priceFeed')) {
    const feed = record(r.priceFeed, ['provider', 'maxAgeMs']);
    if (feed.provider !== 'coingecko') fail('priceFeed.provider must be coingecko');
    result.priceFeed = { provider: 'coingecko' };
    if (Object.hasOwn(feed, 'maxAgeMs')) result.priceFeed.maxAgeMs = integer(feed.maxAgeMs, 'priceFeed.maxAgeMs');
  }
  if (Object.hasOwn(r, 'bounds')) {
    result.bounds = {};
    for (const [name, input] of Object.entries(record(r.bounds))) {
      asset(name, mints);
      const bound = record(input, ['min', 'max']);
      const min = positive(bound.min), max = positive(bound.max);
      if (max < min) fail('inverted price bounds');
      result.bounds[name] = { min, max };
    }
  }
  if (Object.hasOwn(r, 'prices')) {
    result.prices = {};
    for (const [name, value] of Object.entries(record(r.prices))) { asset(name, mints); result.prices[name] = positive(value); }
  }
  return result;
}
function resolveCluster(value: unknown, cluster: SolanaChainId): ResolvedSolanaCluster {
  const r = record(value, CLUSTER_KEYS);
  const j = Object.hasOwn(r, 'jupiter') ? record(r.jupiter, ['enabled', 'allowPoolTransfers', 'pools', 'apiBaseUrl']) : {};
  const a = Object.hasOwn(r, 'alt') ? record(r.alt, ['enabled']) : {};
  if (flag(a, 'enabled')) fail('ALT is disabled in phase 1');
  const f = Object.hasOwn(r, 'fees') ? record(r.fees, ['maxComputeUnitLimit', 'maxComputeUnitPriceMicroLamports', 'maxPriorityFeeLamports', 'maxFeeUsd']) : {};
  const result: ResolvedSolanaCluster = {
    enabled: flag(r, 'enabled'), killSwitch: flag(r, 'killSwitch'), alt: { enabled: false }, allowWsol: flag(r, 'allowWsol'),
    jupiter: { enabled: flag(j, 'enabled'), allowPoolTransfers: flag(j, 'allowPoolTransfers'), pools: [] },
    fees: { maxFeeUsd: Object.hasOwn(f, 'maxFeeUsd') ? decimal(f.maxFeeUsd, 'maxFeeUsd', true) : '0.50' },
  };
  // Flag-only PR1 profiles remain valid. Explicit policy requires an explicit value cap.
  if (Object.keys(r).some((name) => name !== 'enabled' && name !== 'killSwitch') && !Object.hasOwn(r, 'maxPerTxUsd')) fail('maxPerTxUsd is required for policy-bearing clusters');
  if (Object.hasOwn(r, 'maxPerTxUsd')) result.maxPerTxUsd = decimal(r.maxPerTxUsd, 'maxPerTxUsd', true);
  if (Object.hasOwn(r, 'maxRentLamports')) result.maxRentLamports = decimal(r.maxRentLamports, 'maxRentLamports');
  if (Object.hasOwn(r, 'rpcUrls')) {
    result.rpcUrls = list(r.rpcUrls, https);
    if (result.rpcUrls.length !== 2 || new Set(result.rpcUrls.map((url) => new URL(url).hostname)).size !== 2) fail('two distinct RPC providers are required');
  }
  if (Object.hasOwn(r, 'rpcQuorum')) {
    if (r.rpcQuorum !== 2) fail('rpcQuorum must be 2');
    result.rpcQuorum = 2;
  }
  if (Object.hasOwn(r, 'rpcTimeoutMs')) result.rpcTimeoutMs = integer(r.rpcTimeoutMs, 'rpcTimeoutMs', 1, 8000);
  if (Object.hasOwn(r, 'genesisHash')) {
    if (r.genesisHash !== SOLANA_GENESIS_HASHES[cluster]) fail('genesis hash does not match cluster pin');
    result.genesisHash = SOLANA_GENESIS_HASHES[cluster];
  }
  if (Object.hasOwn(r, 'programs')) result.programs = list(r.programs, (value) => {
    const program = key(value, true);
    if (!SOLANA_PHASE1_PROGRAM_IDS.includes(program)) fail('unreviewed phase-1 program');
    return program;
  });
  if (Object.hasOwn(r, 'innerPrograms')) result.innerPrograms = list(r.innerPrograms, (value) => key(value));
  if (Object.hasOwn(r, 'delegates')) result.delegates = list(r.delegates, (value) => key(value));
  if (Object.hasOwn(r, 'nonceAccounts')) {
    result.nonceAccounts = list(r.nonceAccounts, (value) => key(value));
    if (result.nonceAccounts.length) fail('durable nonce accounts are disabled in phase 1');
  }
  if (Object.hasOwn(r, 'mints')) {
    result.mints = {};
    for (const [mint, metadata] of Object.entries(record(r.mints))) {
      key(mint);
      const mainnetMint = Object.hasOwn(SOLANA_PHASE1_MAINNET_MINTS, mint);
      if ((cluster === 'solana:mainnet') !== mainnetMint) fail('mint is not admitted on this cluster');
      const m = record(metadata, ['symbol', 'decimals', 'tokenProgram']);
      if (typeof m.symbol !== 'string' || !m.symbol.length || m.symbol.includes('\0') || m.symbol.normalize('NFC') !== m.symbol) fail('invalid mint symbol');
      if (m.tokenProgram !== TOKEN && m.tokenProgram !== TOKEN_2022) fail('unsupported token program');
      result.mints[mint] = { symbol: m.symbol, decimals: integer(m.decimals, 'mint.decimals', 0, 255), tokenProgram: m.tokenProgram };
    }
  }
  if (Object.hasOwn(r, 'tokenCaps')) {
    result.tokenCaps = {};
    for (const [name, value] of Object.entries(record(r.tokenCaps))) { asset(name, result.mints); result.tokenCaps[name] = decimal(value, 'tokenCap'); }
  }
  if (Object.hasOwn(r, 'price')) result.price = priceConfig(r.price, result.mints);
  if (Object.hasOwn(f, 'maxComputeUnitLimit')) result.fees.maxComputeUnitLimit = integer(f.maxComputeUnitLimit, 'maxComputeUnitLimit', 1, 0xffffffff);
  for (const name of ['maxComputeUnitPriceMicroLamports', 'maxPriorityFeeLamports'] as const) {
    if (Object.hasOwn(f, name)) result.fees[name] = decimal(f[name], name);
  }
  for (const [name, min, max] of [['maxSlippageBps', 0, 10000], ['quoteMaxAgeMs', 1, 30000], ['maxIntentTtlMs', 1, 120000]] as const) {
    if (Object.hasOwn(r, name)) result[name] = integer(r[name], name, min, max);
  }
  if (Object.hasOwn(j, 'apiBaseUrl')) result.jupiter.apiBaseUrl = https(j.apiBaseUrl);
  if (Object.hasOwn(j, 'pools')) {
    if (!Array.isArray(j.pools)) fail('jupiter.pools must be an array');
    const seen = new Set<string>();
    for (const value of j.pools) {
      const p = record(value, POOL_KEYS);
      const pool: SolanaPoolConfig = { ammProgram: key(p.ammProgram), pool: key(p.pool), authority: key(p.authority),
        mintA: key(p.mintA), mintB: key(p.mintB), vaultA: key(p.vaultA), vaultB: key(p.vaultB) };
      if (seen.has(pool.pool) || !result.innerPrograms?.includes(pool.ammProgram)
        || !Object.hasOwn(result.mints ?? {}, pool.mintA) || !Object.hasOwn(result.mints ?? {}, pool.mintB)
        || pool.mintA === pool.mintB || pool.vaultA === pool.vaultB) fail('duplicate or inconsistent Jupiter pool');
      seen.add(pool.pool); result.jupiter.pools.push(pool);
    }
  }
  if (result.jupiter.enabled && (!result.jupiter.pools.length || !result.innerPrograms?.length)) fail('Jupiter requires reviewed pools and inner programs');
  return result;
}

/** Validate dormant settings as strictly as enabled settings; invent no economic caps. */
export function resolveSolanaConfig(value: unknown): ResolvedSolanaConfig {
  const r = value === undefined ? {} : record(value, ['enabled', 'secretKeyPath', 'clusters']);
  const input = Object.hasOwn(r, 'clusters') ? record(r.clusters, SOLANA_CLUSTERS) : {};
  const result: ResolvedSolanaConfig = { enabled: flag(r, 'enabled'), clusters: {
    'solana:mainnet': resolveCluster(Object.hasOwn(input, 'solana:mainnet') ? input['solana:mainnet'] : {}, 'solana:mainnet'),
    'solana:devnet': resolveCluster(Object.hasOwn(input, 'solana:devnet') ? input['solana:devnet'] : {}, 'solana:devnet'),
  } };
  if (Object.hasOwn(r, 'secretKeyPath')) {
    if (typeof r.secretKeyPath !== 'string' || !isAbsolute(r.secretKeyPath) || r.secretKeyPath.includes('\0')) fail('secretKeyPath must be an absolute path');
    result.secretKeyPath = r.secretKeyPath;
  }
  return result;
}

/** Pure configuration readiness only. Does not attest to RPC, custody or signing readiness. */
export function assertSolanaClusterReady(config: ResolvedSolanaConfig, cluster: SolanaChainId): void {
  if (!(SOLANA_CLUSTERS as readonly string[]).includes(cluster)) fail('unknown cluster');
  const c = config.clusters[cluster];
  if (!config.enabled || !c?.enabled || c.killSwitch) fail('cluster is disabled');
  // Revalidate callers' mutable resolved objects without letting defaults hide omissions.
  resolveSolanaConfig({ enabled: config.enabled, secretKeyPath: config.secretKeyPath, clusters: { [cluster]: c } });
  if (!config.secretKeyPath) fail('secretKeyPath is required');
  for (const name of ['rpcUrls', 'rpcQuorum', 'rpcTimeoutMs', 'genesisHash', 'programs', 'innerPrograms', 'mints', 'delegates',
    'nonceAccounts', 'maxPerTxUsd', 'maxRentLamports', 'maxSlippageBps', 'quoteMaxAgeMs', 'maxIntentTtlMs', 'tokenCaps', 'price'] as const) {
    if (c[name] === undefined) fail(`${name} is required for readiness`);
  }
  if (!c.programs?.length || !Object.keys(c.mints ?? {}).length) fail('programs and mints are required');
  for (const name of ['maxComputeUnitLimit', 'maxComputeUnitPriceMicroLamports', 'maxPriorityFeeLamports', 'maxFeeUsd'] as const) {
    if (c.fees[name] === undefined) fail(`fees.${name} is required`);
  }
  if (c.price?.ids?.native !== 'solana' || !c.price.priceFeed) fail('SOL price feed is required');
  for (const name of ['native', ...Object.keys(c.mints ?? {})]) {
    if (c.tokenCaps?.[name] === undefined || !c.price?.bounds?.[name]) fail(`cap and price bounds required for ${name}`);
  }
}

export interface SolanaPoolTransferInput {
  cluster: { jupiter: { allowPoolTransfers: boolean; pools: SolanaPoolConfig[] }; innerPrograms: string[]; delegates: string[] };
  treasury: string;
  intent: { tokenOut: { mint: string }; minAmountOut: string };
  transfer: { destination: string; destinationOwner: string; amount: string; topLevel: boolean; invokingPrograms: string[] };
  outputAccount: { address: string; owner: string; mint: string; derivedAta: string };
  simulatedOutputCredit: string;
  topLevelTransfers: Array<{ destination: string; destinationOwner: string; kind: 'transferChecked' | 'system' | 'approve'; delegate?: string }>;
}

/** Caller supplies verified decoded evidence, including ATA derivation and the complete CPI stack. */
export function assertSolanaPoolTransferAllowed(input: SolanaPoolTransferInput): void {
  const { cluster: c, treasury, intent, transfer: t, outputAccount: out } = input;
  key(treasury); key(intent.tokenOut.mint);
  key(t.destination); key(t.destinationOwner); decimal(t.amount, 'transfer.amount');
  for (const value of [out.address, out.owner, out.mint, out.derivedAta]) key(value);
  const stack = list(t.invokingPrograms, (value) => key(value));
  if (c.jupiter.allowPoolTransfers !== true || t.topLevel !== false || !stack.length) fail('pool transfers require an enabled CPI exemption');
  const pools = c.jupiter.pools.filter((p) => p.vaultA === t.destination || p.vaultB === t.destination);
  if (pools.length !== 1) fail('pool vault is absent or ambiguous');
  const pool = pools[0];
  if (pool.authority !== t.destinationOwner || !c.innerPrograms.includes(pool.ammProgram) || !stack.includes(pool.ammProgram)
    || stack.some((p) => p !== SOLANA_PHASE1_PROGRAM_IDS[0] && !c.innerPrograms.includes(p))) fail('pool CPI program or authority is not admitted');
  if (out.owner !== treasury || out.address !== out.derivedAta || out.mint !== intent.tokenOut.mint) fail('output must be the derived treasury ATA');
  if (BigInt(decimal(input.simulatedOutputCredit, 'output credit')) < BigInt(decimal(intent.minAmountOut, 'minAmountOut'))) fail('output credit below minimum');
  if (!Array.isArray(input.topLevelTransfers)) fail('complete top-level transfer evidence is required');
  for (const top of input.topLevelTransfers) {
    key(top.destination); key(top.destinationOwner);
    if (!['transferChecked', 'system', 'approve'].includes(top.kind) || top.destinationOwner !== treasury) fail('top-level transfer destination is not treasury-owned');
    if (top.kind === 'approve' && (!top.delegate || !c.delegates.includes(key(top.delegate)))) fail('unallowlisted approve delegate');
  }
}
