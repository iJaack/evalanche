/**
 * CoinGecko simple/price fixtures. These tests do not call the network.
 */
import { describe, expect, it } from 'vitest';
import { NATIVE_ADDRESS } from '../../src/signer/decode';
import {
  COINGECKO_PRICE_MAX_AGE_MS,
  COINGECKO_SIMPLE_PRICE_URL,
  NATIVE_COINGECKO_IDS,
  assertCoinGeckoPricePlausible,
  coinGeckoBindings,
  fetchCoinGeckoSimplePrice,
  nativeCoinGeckoId,
  normalizeCoinGeckoFeed,
  parseCoinGeckoSimplePrice,
} from '../../src/signer/price-feed';

const NOW = 1_792_350_353_000;
const FRESH = Math.floor(NOW / 1000);
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CoinGecko simple/price', () => {
  it('maps each pinned chain to a native coin id', () => {
    expect(NATIVE_COINGECKO_IDS).toEqual({
      1: 'ethereum',
      10: 'ethereum',
      56: 'binancecoin',
      137: 'polygon-ecosystem-token',
      4663: 'ethereum',
      8453: 'ethereum',
      42161: 'ethereum',
      43114: 'avalanche-2',
      59144: 'ethereum',
      80094: 'berachain-bera',
    });
    expect(nativeCoinGeckoId(25, undefined)).toBeUndefined();
    expect(nativeCoinGeckoId(43114, { native: 'avalanche-2' })).toBe('avalanche-2');
    expect(nativeCoinGeckoId(137, undefined)).toBe('polygon-ecosystem-token');
  });

  it('accepts only the official https simple/price URL', () => {
    expect(normalizeCoinGeckoFeed('coingecko', 'priceFeed')).toEqual({
      provider: 'coingecko',
      url: COINGECKO_SIMPLE_PRICE_URL,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
    });
    expect(() => normalizeCoinGeckoFeed({
      provider: 'coingecko',
      url: 'https://pro-api.coingecko.com/api/v3/simple/price',
    }, 'priceFeed')).toThrow(/simple\/price/);
    expect(() => normalizeCoinGeckoFeed({ provider: 'coingecko', url: 'http://api.coingecko.com/api/v3/simple/price' }, 'priceFeed')).toThrow(/https/);
    expect(() => normalizeCoinGeckoFeed({ provider: 'coingecko', url: 'https://example.com/api/v3/simple/price' }, 'priceFeed')).toThrow(/simple\/price/);
    expect(() => normalizeCoinGeckoFeed({ provider: 'binance' }, 'priceFeed')).toThrow(/coingecko/);
    expect(() => normalizeCoinGeckoFeed({ provider: 'coingecko', url: 'https://user:pw@api.coingecko.com/api/v3/simple/price' }, 'priceFeed')).toThrow(/https/);
  });

  it('parses a fresh fixture and refuses a malformed, missing, stale, or non-positive price', () => {
    const bindings = coinGeckoBindings(43114, { [USDC]: 'usd-coin' });
    expect(bindings.map((binding) => binding.coinId).sort()).toEqual(['avalanche-2', 'usd-coin']);
    const parsed = parseCoinGeckoSimplePrice({
      'avalanche-2': { usd: 20.5, last_updated_at: FRESH },
      'usd-coin': { usd: 1, last_updated_at: FRESH },
    }, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS);
    expect(parsed[NATIVE_ADDRESS.toLowerCase()]).toBe(20.5);
    expect(parsed[USDC.toLowerCase()]).toBe(1);

    expect(() => parseCoinGeckoSimplePrice(null, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/malformed/);
    expect(() => parseCoinGeckoSimplePrice([], bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/malformed/);
    expect(() => parseCoinGeckoSimplePrice({ 'usd-coin': { usd: 1, last_updated_at: FRESH } }, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/missing a price/);
    expect(() => parseCoinGeckoSimplePrice({
      'avalanche-2': { usd: '20', last_updated_at: FRESH },
      'usd-coin': { usd: 1, last_updated_at: FRESH },
    }, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/malformed/);
    expect(() => parseCoinGeckoSimplePrice({
      'avalanche-2': { usd: 0, last_updated_at: FRESH },
      'usd-coin': { usd: 1, last_updated_at: FRESH },
    }, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/malformed/);
    expect(() => parseCoinGeckoSimplePrice({
      'avalanche-2': { usd: 20, last_updated_at: FRESH - 601 },
      'usd-coin': { usd: 1, last_updated_at: FRESH },
    }, bindings, NOW, 60_000)).toThrow(/stale/);
    expect(() => parseCoinGeckoSimplePrice({
      'avalanche-2': { usd: 20, last_updated_at: FRESH + 120 },
      'usd-coin': { usd: 1, last_updated_at: FRESH },
    }, bindings, NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/stale/);
    expect(() => parseCoinGeckoSimplePrice({}, [], NOW, COINGECKO_PRICE_MAX_AGE_MS)).toThrow(/no ids/);
  });

  it('requests the official https URL and does not follow a live host', async () => {
    const bindings = coinGeckoBindings(1, undefined);
    let seen = '';
    const prices = await fetchCoinGeckoSimplePrice({
      url: COINGECKO_SIMPLE_PRICE_URL,
      bindings,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
      nowMs: NOW,
      fetchImpl: async (url) => {
        seen = url;
        return jsonResponse({ ethereum: { usd: 3000, last_updated_at: FRESH } });
      },
    });
    expect(seen.startsWith('https://api.coingecko.com/api/v3/simple/price?')).toBe(true);
    expect(seen).toContain('ids=ethereum');
    expect(seen).toContain('vs_currencies=usd');
    expect(seen).toContain('include_last_updated_at=true');
    expect(prices[NATIVE_ADDRESS.toLowerCase()]).toBe(3000);
    await expect(fetchCoinGeckoSimplePrice({
      url: 'http://api.coingecko.com/api/v3/simple/price',
      bindings,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
      fetchImpl: async () => jsonResponse({}),
    })).rejects.toThrow(/https/);
    await expect(fetchCoinGeckoSimplePrice({
      url: COINGECKO_SIMPLE_PRICE_URL,
      bindings,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
      nowMs: NOW,
      fetchImpl: async () => jsonResponse({}, 500),
    })).rejects.toThrow(/Price feed request failed/);
    await expect(fetchCoinGeckoSimplePrice({
      url: COINGECKO_SIMPLE_PRICE_URL,
      bindings,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
      nowMs: NOW,
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    })).rejects.toThrow(/malformed/);
  });

  it('keeps a feed price inside a min/max or within 50% of a positive reference', () => {
    const native = NATIVE_ADDRESS.toLowerCase();
    const usdc = USDC.toLowerCase();
    const reference = { [native]: 20 };
    expect(() => assertCoinGeckoPricePlausible({ [native]: 10 }, undefined, reference)).not.toThrow();
    expect(() => assertCoinGeckoPricePlausible({ [native]: 30 }, undefined, reference)).not.toThrow();
    expect(() => assertCoinGeckoPricePlausible({ [native]: 9.99 }, undefined, reference)).toThrow(/outside the sanity bound/);
    expect(() => assertCoinGeckoPricePlausible({ [native]: 30.01 }, undefined, reference)).toThrow(/outside the sanity bound/);
    const bounds = { [native]: { min: 1, max: 100 } };
    expect(() => assertCoinGeckoPricePlausible({ [native]: 20 }, bounds, undefined)).not.toThrow();
    expect(() => assertCoinGeckoPricePlausible({ [native]: 101 }, bounds, undefined)).toThrow(/outside the sanity bound/);
    expect(() => assertCoinGeckoPricePlausible({ [native]: 40 }, bounds, reference)).toThrow(/outside the sanity bound/);
    expect(() => assertCoinGeckoPricePlausible({ [native]: 20 }, undefined, { [native]: 0 })).toThrow(/no sanity bound/);
    expect(() => assertCoinGeckoPricePlausible({ [native]: 20 }, undefined, undefined)).toThrow(/no sanity bound/);
    expect(() => assertCoinGeckoPricePlausible(
      { [native]: 20, [usdc]: 1 },
      bounds,
      undefined,
    )).toThrow(/no sanity bound/);
  });

  it('refuses redirects, oversized bodies, and timeouts on the official host', async () => {
    const bindings = coinGeckoBindings(1, undefined);
    const original = globalThis.fetch;
    const base = {
      url: COINGECKO_SIMPLE_PRICE_URL,
      bindings,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
      nowMs: NOW,
    };
    try {
      let calls = 0;
      let init: RequestInit | undefined;
      globalThis.fetch = (async (_url: string, options?: RequestInit) => {
        calls += 1;
        init = options;
        return new Response(JSON.stringify({ ethereum: { usd: 3000, last_updated_at: FRESH } }), {
          status: 302,
          headers: { location: 'https://evil.example/price', 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      await expect(fetchCoinGeckoSimplePrice(base)).rejects.toThrow(/Price feed request failed/);
      expect(init?.redirect).toBe('error');
      expect(calls).toBe(1);

      globalThis.fetch = (async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '1000001' },
      })) as typeof fetch;
      await expect(fetchCoinGeckoSimplePrice(base)).rejects.toThrow(/too large/);

      globalThis.fetch = ((_url: string, options?: RequestInit) => new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted'));
        }, { once: true });
      })) as typeof fetch;
      await expect(fetchCoinGeckoSimplePrice({ ...base, timeoutMs: 30 })).rejects.toThrow(/Network request failed/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
