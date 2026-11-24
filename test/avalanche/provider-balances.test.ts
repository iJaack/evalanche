import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pGetUTXOs: vi.fn(),
  xGetUTXOs: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('@avalanche-sdk/client', () => ({
  createAvalancheClient: vi.fn(() => ({
    pChain: { getUTXOs: mocks.pGetUTXOs },
    xChain: { getUTXOs: mocks.xGetUTXOs },
  })),
}));
vi.mock('@avalanche-sdk/client/utils', () => ({
  // Each fake UTXO hex is "<assetId>:<amount>".
  getUtxoFromBytes: (hex: string) => {
    const [assetId, amount] = hex.split(':');
    return { getAssetId: () => assetId, output: { amount: () => BigInt(amount) } };
  },
}));
vi.mock('../../src/utils/safe-fetch', () => ({ safeFetch: mocks.safeFetch }));

import { AVAX_ASSET_IDS, clearProviderCache, createAvalancheProvider } from '../../src/avalanche/provider';

const AVAX = AVAX_ASSET_IDS.avalanche;

describe('Avalanche provider balances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProviderCache();
  });

  it('reads every UTXO page for the P-Chain balance', async () => {
    // A full page (1024 entries) means there may be more, so the provider must ask for the next one.
    const firstPage = [`${AVAX}:5`, ...Array.from({ length: 1023 }, (_, i) => `${AVAX}:0:${i}`)];
    mocks.pGetUTXOs
      .mockResolvedValueOnce({ numFetched: '1024', utxos: firstPage, endIndex: { address: 'P-avax1a', utxo: 'u1' } })
      .mockResolvedValueOnce({ numFetched: '2', utxos: [`${AVAX}:7`, 'other:1000'], endIndex: { address: 'P-avax1a', utxo: 'u2' } });
    const provider = await createAvalancheProvider('avalanche');
    expect(await provider.getPBalance('P-avax1a')).toBe(12n);
    expect(mocks.pGetUTXOs).toHaveBeenNthCalledWith(1, { addresses: ['P-avax1a'], limit: 1024, startIndex: undefined });
    expect(mocks.pGetUTXOs).toHaveBeenNthCalledWith(2, {
      addresses: ['P-avax1a'], limit: 1024, startIndex: { address: 'P-avax1a', utxo: 'u1' },
    });
  });

  it('reads the X-Chain balance from X-Chain UTXOs', async () => {
    mocks.xGetUTXOs.mockResolvedValueOnce({ numFetched: 1, utxos: [`${AVAX_ASSET_IDS.fuji}:42`] });
    const provider = await createAvalancheProvider('fuji');
    expect(await provider.getXBalance('X-fuji1a')).toBe(42n);
    expect(mocks.pGetUTXOs).not.toHaveBeenCalled();
  });

  it('reads stake from the Data API with the network and bech32 address', async () => {
    mocks.safeFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ balances: { unlockedStaked: [{ assetId: AVAX_ASSET_IDS.fuji, amount: '2500' }] } }),
    });
    const provider = await createAvalancheProvider('fuji');
    expect(await provider.getPStake('P-fuji1abc')).toBe(2500n);
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://data-api.avax.network/v1/networks/fuji/blockchains/p-chain/balances?addresses=fuji1abc',
    );
  });

  it('fails loudly when the Data API does', async () => {
    mocks.safeFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const provider = await createAvalancheProvider('avalanche');
    await expect(provider.getPStake('P-avax1abc')).rejects.toThrow(/HTTP 503/);
    expect(mocks.safeFetch.mock.calls[0][0]).toContain('/networks/mainnet/');
  });
});
