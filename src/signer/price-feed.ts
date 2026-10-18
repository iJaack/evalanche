/**
 * CoinGecko `simple/price` adapter for a chain's `price.priceFeed`.
 *
 * The response is `{ "<coin-id>": { "usd": number, "last_updated_at": seconds } }`.
 * Ids come from `price.ids`, with the native id filled from
 * {@link NATIVE_COINGECKO_IDS} when config omits it. A missing, malformed,
 * non-positive, or stale price throws. The signer does not keep the last
 * good value. HTTPS only, and only the public CoinGecko simple/price URL.
 * A returned price must also sit inside a configured min/max or within 50%
 * of a positive static price. Otherwise the feed fails closed.
 */

import { getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
import { NATIVE_ADDRESS } from './decode';

export const COINGECKO_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
/** Upstream `last_updated_at` older than this is refused. The cache TTL is separate. */
export const COINGECKO_PRICE_MAX_AGE_MS = 10 * 60 * 1000;
const FEED_TIMEOUT_MS = 5_000;
const FEED_MAX_BYTES = 1_000_000;
const FUTURE_SKEW_MS = 60_000;
const COIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * CoinGecko id for the chain's native coin. ETH-priced chains share `ethereum`.
 * Polygon is POL (`polygon-ecosystem-token`), not the legacy MATIC id.
 * Sonic is `sonic-3`. HyperEVM's native HYPE is `hyperliquid`.
 */
export const NATIVE_COINGECKO_IDS: Readonly<Record<number, string>> = {
  1: 'ethereum',
  10: 'ethereum',
  56: 'binancecoin',
  137: 'polygon-ecosystem-token',
  146: 'sonic-3',
  999: 'hyperliquid',
  4663: 'ethereum',
  8453: 'ethereum',
  42161: 'ethereum',
  43114: 'avalanche-2',
  59144: 'ethereum',
  80094: 'berachain-bera',
};

const ALLOWED_URLS = new Set([
  COINGECKO_SIMPLE_PRICE_URL,
]);

export interface CoinGeckoPriceFeed {
  provider: 'coingecko';
  url: string;
  maxAgeMs: number;
}

export interface CoinGeckoPriceBinding {
  /** Lowercase address. Native is the zero address. */
  address: string;
  coinId: string;
}

export interface CoinGeckoPriceFeedInput {
  provider?: string;
  url?: string;
  maxAgeMs?: number;
}

/** Inclusive USD band for one asset. `min` is positive and `max` is at least `min`. */
export interface CoinGeckoPriceBound {
  min: number;
  max: number;
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}

function priceFail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}

export function normalizeCoinGeckoFeed(
  feed: 'coingecko' | CoinGeckoPriceFeedInput | undefined,
  label: string,
): CoinGeckoPriceFeed | undefined {
  if (feed === undefined) return undefined;
  const provider = feed === 'coingecko' ? 'coingecko' : feed.provider;
  if (provider !== 'coingecko') fail(`${label} provider must be coingecko`);
  const url = feed === 'coingecko' || feed.url === undefined ? COINGECKO_SIMPLE_PRICE_URL : feed.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label} url must be https`);
  }
  if (parsed.protocol !== 'https:') fail(`${label} url must be https`);
  if (parsed.username || parsed.password) fail(`${label} url must be https`);
  parsed.search = '';
  parsed.hash = '';
  const canonical = parsed.toString().replace(/\/$/, '');
  if (!ALLOWED_URLS.has(canonical)) fail(`${label} url must be the CoinGecko simple/price endpoint`);
  const maxAgeMs = feed === 'coingecko' || feed.maxAgeMs === undefined
    ? COINGECKO_PRICE_MAX_AGE_MS
    : feed.maxAgeMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 24 * 60 * 60 * 1000) {
    fail(`${label}.maxAgeMs must be a positive integer up to 24 hours`);
  }
  return { provider: 'coingecko', url: canonical, maxAgeMs };
}

export function nativeCoinGeckoId(chainId: number, ids: Record<string, string> | undefined): string | undefined {
  const listed = ids?.native ?? ids?.[NATIVE_ADDRESS] ?? ids?.[NATIVE_ADDRESS.toLowerCase()];
  if (typeof listed === 'string' && listed.length > 0) return listed;
  return NATIVE_COINGECKO_IDS[chainId];
}

export function coinGeckoBindings(
  chainId: number,
  ids: Record<string, string> | undefined,
): CoinGeckoPriceBinding[] {
  const map = new Map<string, string>();
  const native = nativeCoinGeckoId(chainId, ids);
  if (native) map.set(NATIVE_ADDRESS.toLowerCase(), native);
  for (const [key, value] of Object.entries(ids ?? {})) {
    if (typeof value !== 'string' || !COIN_ID.test(value)) {
      fail('price.ids values must be CoinGecko coin ids');
    }
    if (key === 'native') {
      map.set(NATIVE_ADDRESS.toLowerCase(), value);
      continue;
    }
    let address: string;
    try {
      address = getAddress(key);
    } catch {
      fail('price.ids keys must be addresses or native');
    }
    if (address === NATIVE_ADDRESS) {
      map.set(NATIVE_ADDRESS.toLowerCase(), value);
      continue;
    }
    map.set(address.toLowerCase(), value);
  }
  return [...map.entries()].map(([address, coinId]) => ({ address, coinId }));
}

/**
 * Map a simple/price body onto lowercase addresses. Every binding must be
 * present, positive, finite, representable as USD micros, and fresh.
 */
export function parseCoinGeckoSimplePrice(
  body: unknown,
  bindings: readonly CoinGeckoPriceBinding[],
  nowMs: number,
  maxAgeMs: number,
): Record<string, number> {
  if (bindings.length === 0) priceFail('Price feed has no ids');
  if (!body || typeof body !== 'object' || Array.isArray(body)) priceFail('Price feed response is malformed');
  const table = body as Record<string, unknown>;
  const parsed = new Map<string, number>();
  for (const binding of bindings) {
    if (parsed.has(binding.coinId)) continue;
    const entry = table[binding.coinId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) priceFail('Price feed is missing a price');
    const row = entry as Record<string, unknown>;
    const usd = row.usd;
    const updated = row.last_updated_at;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) priceFail('Price feed response is malformed');
    const micros = Math.round(usd * 1_000_000);
    if (!Number.isSafeInteger(micros)) priceFail('Price feed response is malformed');
    if (typeof updated !== 'number' || !Number.isInteger(updated)) priceFail('Price feed response is malformed');
    const updatedMs = updated * 1000;
    if (nowMs - updatedMs > maxAgeMs) priceFail('Price feed price is stale');
    if (updatedMs - nowMs > FUTURE_SKEW_MS) priceFail('Price feed price is stale');
    parsed.set(binding.coinId, usd);
  }
  const out: Record<string, number> = {};
  for (const binding of bindings) {
    const usd = parsed.get(binding.coinId);
    if (usd === undefined) priceFail('Price feed is missing a price');
    out[binding.address] = usd;
  }
  return out;
}

function usdMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

/**
 * Fail closed unless every feed price is plausible. A configured bound must
 * contain the price. A positive static reference must contain it in
 * [reference/2, reference×3/2]. Both apply when both exist. An asset with
 * neither is refused. Comparison is on USD micros so the edges are inclusive.
 */
export function assertCoinGeckoPricePlausible(
  prices: Record<string, number>,
  bounds: Readonly<Record<string, CoinGeckoPriceBound>> | undefined,
  references: Readonly<Record<string, number>> | undefined,
): void {
  for (const [address, usd] of Object.entries(prices)) {
    const bound = bounds?.[address];
    const reference = references?.[address];
    const hasReference = typeof reference === 'number' && Number.isFinite(reference) && reference > 0;
    if (!bound && !hasReference) priceFail('Price feed price has no sanity bound');
    const micros = usdMicros(usd);
    if (bound && (micros < usdMicros(bound.min) || micros > usdMicros(bound.max))) {
      priceFail('Price feed price is outside the sanity bound');
    }
    if (hasReference) {
      const ref = usdMicros(reference);
      if (micros * 2n < ref || micros * 2n > ref * 3n) priceFail('Price feed price is outside the sanity bound');
    }
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchCoinGeckoSimplePrice(input: {
  url: string;
  bindings: readonly CoinGeckoPriceBinding[];
  maxAgeMs: number;
  nowMs?: number;
  /** Passed to {@link safeFetch} when `fetchImpl` is omitted. Defaults to 5s. */
  timeoutMs?: number;
  /** Passed to {@link safeFetch} when `fetchImpl` is omitted. Defaults to 1 MB. */
  maxBytes?: number;
  fetchImpl?: FetchLike;
}): Promise<Record<string, number>> {
  const ids = [...new Set(input.bindings.map((binding) => binding.coinId))];
  if (ids.length === 0) priceFail('Price feed has no ids');
  const endpoint = new URL(input.url);
  if (endpoint.protocol !== 'https:') priceFail('Price feed url must be https');
  endpoint.searchParams.set('ids', ids.join(','));
  endpoint.searchParams.set('vs_currencies', 'usd');
  endpoint.searchParams.set('include_last_updated_at', 'true');
  const response = input.fetchImpl
    ? await input.fetchImpl(endpoint.toString(), { method: 'GET', headers: { accept: 'application/json' } })
    : await safeFetch(endpoint.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: input.timeoutMs ?? FEED_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? FEED_MAX_BYTES,
    });
  if (response.status >= 300 && response.status < 400) {
    throw new EvalancheError('Price feed request failed', EvalancheErrorCode.NETWORK_ERROR);
  }
  if (!response.ok) {
    throw new EvalancheError('Price feed request failed', EvalancheErrorCode.NETWORK_ERROR);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new EvalancheError(
      'Price feed response is malformed',
      EvalancheErrorCode.SIGNER_REJECTED,
      error instanceof Error ? error : undefined,
    );
  }
  return parseCoinGeckoSimplePrice(body, input.bindings, input.nowMs ?? Date.now(), input.maxAgeMs);
}
