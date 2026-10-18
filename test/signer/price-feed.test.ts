/**
 * CoinGecko simple/price fixtures. These tests do not call the network.
 */
import { describe, expect, it } from 'vitest';
import { NATIVE_ADDRESS } from '../../src/signer/decode';
import {
  COINGECKO_PRICE_MAX_AGE_MS,
  COINGECKO_SIMPLE_PRICE_URL,
  NATIVE_COINGECKO_IDS,
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

  it('accepts only the official https simple/price URLs', () => {
    expect(normalizeCoinGeckoFeed('coingecko', 'priceFeed')).toEqual({
      provider: 'coingecko',
      url: COINGECKO_SIMPLE_PRICE_URL,
      maxAgeMs: COINGECKO_PRICE_MAX_AGE_MS,
    });
    expect(normalizeCoinGeckoFeed({
      provider: 'coingecko',
      url: 'https://pro-api.coingecko.com/api/v3/simple/price',
      maxAgeMs: 60_000,
    }, 'priceFeed')?.url).toBe('https://pro-api.coingecko.com/api/v3/simple/price');
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
});
