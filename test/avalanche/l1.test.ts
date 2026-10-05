import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAvalancheL1Network, listAvalancheL1s } from '../../src/avalanche/l1';
import { Evalanche } from '../../src/agent';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const beam = { chainId: '4337', status: 'OK', chainName: 'Beam', vmName: 'EVM', private: false,
  subnetId: 'beam-subnet', platformChainId: 'beam-blockchain', isTestnet: false,
  rpcUrl: 'https://example.com/rpc', explorerUrl: 'https://example.com',
  networkToken: { name: 'Beam', symbol: 'BEAM', decimals: 18 } };
function mockCatalog(chains: unknown[] = [beam]) {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ chains })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('Avalanche L1 discovery', () => {
  it('filters primary, private, unavailable and non-EVM chains', async () => {
    mockCatalog([beam, { ...beam, chainId: '1', subnetId: '11111111111111111111111111111111LpoYY' },
      { ...beam, private: true }, { ...beam, status: 'ERROR' }, { ...beam, vmName: 'Custom' }]);
    expect(await listAvalancheL1s()).toEqual([{ chainId: 4337, name: 'Beam', blockchainId: 'beam-blockchain',
      subnetId: 'beam-subnet', rpcUrl: beam.rpcUrl, explorer: beam.explorerUrl,
      nativeCurrency: beam.networkToken, isTestnet: false }]);
  });
  it('resolves Fuji metadata and keeps API credentials off the RPC', async () => {
    const fetch = mockCatalog([{ ...beam, isTestnet: true }]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10f1' })));
    const network = await getAvalancheL1Network(4337, { network: 'fuji', apiKey: 'catalog-only' });
    expect(fetch.mock.calls[0][0]).toContain('network=fuji');
    expect(fetch.mock.calls[0][1].headers).toEqual({ 'x-glacier-api-key': 'catalog-only' });
    expect(fetch.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, network });
    expect(agent.getChainInfo()).toMatchObject({ id: 4337, currency: { symbol: 'BEAM' }, isTestnet: true });
    agent.provider.destroy();
  });
  it.each(['0x1', '4337', undefined])('rejects incorrect or malformed RPC chain IDs (%s)', async (result) => {
    mockCatalog().mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })));
    await expect(getAvalancheL1Network(4337)).rejects.toThrow('mismatch');
  });
  it('rejects RPC errors and missing catalog chains', async () => {
    mockCatalog().mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1 } })));
    await expect(getAvalancheL1Network(4337)).rejects.toThrow('mismatch');
    mockCatalog();
    await expect(getAvalancheL1Network(999)).rejects.toThrow('not in');
  });
  it.each([{ chainId: '9007199254740993' }, { rpcUrl: 'file:///tmp/rpc' },
    { networkToken: { name: 'Token', symbol: 'T', decimals: 6 } }])('rejects unsafe metadata %j', async (change) => {
    mockCatalog([{ ...beam, ...change }]);
    await expect(listAvalancheL1s()).rejects.toThrow('metadata');
  });
  it('rejects invalid catalog responses and HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    await expect(listAvalancheL1s()).rejects.toThrow('catalog');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(listAvalancheL1s()).rejects.toThrow('429');
  });
  it('prevents L1 mnemonic wallets from signing on the Primary Network', async () => {
    const agent = new Evalanche({ mnemonic: 'test test test test test test test test test test test junk',
      network: { chainId: 4337, rpcUrl: beam.rpcUrl } });
    await expect(agent.pChain()).rejects.toThrow('L1s use their EVM wallet');
    agent.provider.destroy();
  });
  it('rejects an RPC that changes chain ID after network resolution', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, network: { rpcUrl, chainId: 4337 } });
    try { await expect(agent.provider.getNetwork()).rejects.toThrow('network changed'); }
    finally {
      agent.provider.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('keeps chain allowlists when switching the wallet to an L1', async () => {
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, policy: { allowlistedChains: [43114] } });
    const l1 = agent.switchNetwork({ chainId: 4337, rpcUrl: beam.rpcUrl });
    try {
      expect(l1.address).toBe(agent.address);
      await expect(l1.authorizeTransaction({ to: agent.address, valueWei: '0' })).rejects.toThrow('not in the allowlist');
    } finally { agent.provider.destroy(); l1.provider.destroy(); }
  });
  it('shares recorded wallet budgets across network switches', async () => {
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, policy: { maxPerDay: '100' } });
    agent.recordExternalSpend(agent.address, '60', 'first');
    const l1 = agent.switchNetwork({ chainId: 4337, rpcUrl: beam.rpcUrl });
    try {
      await expect(l1.authorizeTransaction({ to: agent.address, valueWei: '50' })).rejects.toThrow();
      l1.recordExternalSpend(l1.address, '20', 'second');
      expect(agent.getBudgetStatus()?.spentLastDay).toBe('80');
      expect(l1.getBudgetStatus()?.spentLastDay).toBe('80');
    } finally { agent.provider.destroy(); l1.provider.destroy(); }
  });
});
