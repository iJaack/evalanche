import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Robinhood Chain RPC configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the official public RPC by default', async () => {
    vi.stubEnv('ROBINHOOD_RPC_URLS', '');
    vi.stubEnv('EVALANCHE_ROBINHOOD_RPC_URLS', '');
    vi.resetModules();

    const { getNetworkConfig } = await import('../../src/utils/networks');

    expect(getNetworkConfig('robinhood').rpcUrl)
      .toBe('https://rpc.mainnet.chain.robinhood.com');
  });

  it('prefers deduplicated environment RPC overrides', async () => {
    vi.stubEnv('ROBINHOOD_RPC_URLS', 'https://rpc.example/one, https://rpc.example/two');
    vi.stubEnv('EVALANCHE_ROBINHOOD_RPC_URLS', 'https://rpc.example/two');
    vi.resetModules();

    const { CHAINS } = await import('../../src/utils/chains');

    expect(CHAINS[4663].rpc).toEqual([
      'https://rpc.example/one',
      'https://rpc.example/two',
      'https://rpc.mainnet.chain.robinhood.com',
    ]);
  });
});
