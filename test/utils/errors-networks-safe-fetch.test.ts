import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvalancheError, EvalancheErrorCode } from '../../src/utils/errors';
import { getNetworkConfig, getChainConfigForNetwork, NETWORKS } from '../../src/utils/networks';
import { assertSafeUrl, safeFetch } from '../../src/utils/safe-fetch';

describe('EvalancheError', () => {
  it('stores code and underlying error', () => {
    const underlying = new Error('boom');
    const err = new EvalancheError('top level', EvalancheErrorCode.NETWORK_ERROR, underlying);
    expect(err.code).toBe(EvalancheErrorCode.NETWORK_ERROR);
    expect(err.underlying).toBe(underlying);
    expect(err.toString()).toBe('[NETWORK_ERROR] top level');
    expect(err.stack).toBe(underlying.stack);
  });
});

describe('networks', () => {
  it('resolves known network aliases', () => {
    expect(NETWORKS.base.chainId).toBe(8453);
    const cfg = getNetworkConfig('base');
    expect(cfg.chainId).toBe(8453);
    expect(cfg.rpcUrl.length).toBeGreaterThan(0);
    expect(NETWORKS.robinhood.chainId).toBe(4663);
    expect(getNetworkConfig('robinhood')).toMatchObject({
      chainId: 4663,
      name: 'Robinhood Chain',
      explorer: 'https://robinhoodchain.blockscout.com',
    });
  });

  it('throws on unknown alias', () => {
    expect(() => getNetworkConfig('not-a-chain' as any)).toThrow(/Unknown network/);
  });

  it('resolves custom configs and chain registry lookups', () => {
    const cfg = getNetworkConfig({ rpcUrl: 'https://rpc.example', chainId: 999, name: 'CustomNet' });
    expect(cfg).toEqual({ rpcUrl: 'https://rpc.example', chainId: 999, name: 'CustomNet', explorer: '' });
    expect(getChainConfigForNetwork('avalanche')?.id).toBe(43114);
    expect(getChainConfigForNetwork({ rpcUrl: 'https://rpc.example', chainId: 999 })).toBeUndefined();
  });
});

describe('safe-fetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('assertSafeUrl blocks unsupported protocols', () => {
    expect(() => assertSafeUrl('ftp://example.com')).toThrow(/Unsupported URL protocol/);
  });

  it('assertSafeUrl blocks private targets when enabled', () => {
    expect(() => assertSafeUrl('https://127.0.0.1/test', { blockPrivateNetwork: true })).toThrow(/Blocked private or loopback/);
    expect(() => assertSafeUrl('https://internal.local/test', { blockPrivateNetwork: true })).toThrow(/Blocked private or loopback/);
  });

  it('allows http only when explicitly enabled', () => {
    expect(() => assertSafeUrl('http://example.com')).toThrow();
    expect(assertSafeUrl('http://example.com', { allowHttp: true }).toString()).toBe('http://example.com/');
  });

  it('passes through successful responses', async () => {
    mockFetch.mockResolvedValueOnce({
      headers: { get: () => '10' },
      ok: true,
      status: 200,
    });
    const res = await safeFetch('https://example.com', { maxBytes: 100 });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws if content-length exceeds maxBytes', async () => {
    mockFetch.mockResolvedValueOnce({
      headers: { get: () => '1000' },
      ok: true,
      status: 200,
    });
    await expect(safeFetch('https://example.com', { maxBytes: 100 })).rejects.toThrow(/Response too large/);
  });

  it('wraps fetch errors in EvalancheError', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(safeFetch('https://example.com')).rejects.toMatchObject({ code: EvalancheErrorCode.NETWORK_ERROR });
  });
});
