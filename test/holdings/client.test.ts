import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldingsClient } from '../../src/holdings/client';

const CONTRACT_STATE: Record<string, Record<string, unknown>> = {
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': {
    balanceOf: vi.fn().mockResolvedValue(2873245n),
  },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
    balanceOf: vi.fn().mockResolvedValue(0n),
  },
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': {
    balanceOf: vi.fn().mockResolvedValue(23810n),
  },
  '0x4200000000000000000000000000000000000006': {
    balanceOf: vi.fn().mockResolvedValue(2390765408n),
  },
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': {
    balanceOf: vi.fn().mockResolvedValue(0n),
  },
  '0x696f9436b67233384889472cd7cd58a6fb5df4f1': {
    balanceOf: vi.fn().mockResolvedValue(0n),
  },
  '0x0000000f2eb9f69274678c76222b35eec7588a65': {
    balanceOf: vi.fn().mockResolvedValue(24917987n),
    decimals: vi.fn().mockResolvedValue(6),
    asset: vi.fn().mockResolvedValue('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    convertToAssets: vi.fn().mockResolvedValue(26771162n),
    symbol: vi.fn().mockResolvedValue('yoUSD'),
  },
  '0x944766f715b51967e56afde5f0aa76ceacc9e7f9': {
    balanceOf: vi.fn().mockResolvedValue(14559205n),
    decimals: vi.fn().mockResolvedValue(6),
    asset: vi.fn().mockResolvedValue('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    convertToAssets: vi.fn().mockResolvedValue(19423208n),
    symbol: vi.fn().mockResolvedValue('avUSDC'),
  },
  '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be': {
    balanceOf: vi.fn().mockResolvedValue(2707406775898401245n),
    decimals: vi.fn().mockResolvedValue(18),
    symbol: vi.fn().mockResolvedValue('sAVAX'),
  },
  '0xbeb5d47a3f720ec0a390d04b4d41ed7d9688bc7f': {
    balanceOf: vi.fn().mockResolvedValue(0n),
    decimals: vi.fn().mockResolvedValue(8),
    symbol: vi.fn().mockResolvedValue('qiUSDC'),
  },
};

vi.mock('ethers', () => {
  class MockContract {
    constructor(address: string) {
      return CONTRACT_STATE[address.toLowerCase()] ?? {
        balanceOf: vi.fn().mockResolvedValue(0n),
        decimals: vi.fn().mockResolvedValue(18),
        symbol: vi.fn().mockResolvedValue('TOKEN'),
        asset: vi.fn().mockResolvedValue('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
        convertToAssets: vi.fn().mockResolvedValue(0n),
      };
    }
  }

  return {
    Contract: MockContract,
    getAddress: (value: string) => value,
    formatEther: (value: bigint) => (Number(value) / 1e18).toString(),
    formatUnits: (value: bigint, decimals: number) => (Number(value) / (10 ** decimals)).toString(),
  };
});

describe('HoldingsClient', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('data-api.polymarket.com/positions')) {
        return new Response(JSON.stringify([
          {
            conditionId: '0xcondition',
            title: 'Trump out as President before GTA VI?',
            outcome: 'NO',
            size: 4.255316,
            currentValue: 1.97872194,
            asset: '123',
          },
        ]), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any;
  });

  it('returns a unified holdings list across tokens, defi, prediction, and perps', async () => {
    const providers = {
      polygon: { getBalance: vi.fn().mockResolvedValue(142502074913827736n) },
      base: { getBalance: vi.fn().mockResolvedValue(144867066506944n) },
      avalanche: { getBalance: vi.fn().mockResolvedValue(27346390940518239n) },
      arbitrum: { getBalance: vi.fn().mockResolvedValue(42787455681216n) },
      ethereum: { getBalance: vi.fn().mockResolvedValue(0n) },
      optimism: { getBalance: vi.fn().mockResolvedValue(0n) },
      bsc: { getBalance: vi.fn().mockResolvedValue(0n) },
    } as Record<string, { getBalance: ReturnType<typeof vi.fn> }>;

    const chainMeta: Record<string, { id: number; name: string; currency: { symbol: string } }> = {
      polygon: { id: 137, name: 'Polygon', currency: { symbol: 'POL' } },
      base: { id: 8453, name: 'Base', currency: { symbol: 'ETH' } },
      avalanche: { id: 43114, name: 'Avalanche', currency: { symbol: 'AVAX' } },
      arbitrum: { id: 42161, name: 'Arbitrum', currency: { symbol: 'ETH' } },
      ethereum: { id: 1, name: 'Ethereum', currency: { symbol: 'ETH' } },
      optimism: { id: 10, name: 'Optimism', currency: { symbol: 'ETH' } },
      bsc: { id: 56, name: 'BNB Smart Chain', currency: { symbol: 'BNB' } },
    };

    const makeAgent = (chain: keyof typeof providers) => ({
      address: '0x0fe61780bd5508b3C99e420662050e5560608cA4',
      provider: providers[chain],
      getChainInfo: () => chainMeta[chain],
      switchNetwork: (next: keyof typeof providers) => makeAgent(next),
      hyperliquid: vi.fn().mockResolvedValue({
        getPositions: vi.fn().mockResolvedValue([
          {
            venue: 'hyperliquid',
            market: 'BTC',
            side: 'LONG',
            size: '0.01',
            entryPrice: '100000',
            unrealizedPnl: '5',
          },
        ]),
      }),
      dydx: vi.fn().mockResolvedValue({
        getPositions: vi.fn().mockResolvedValue([
          {
            venue: 'dydx',
            market: 'ETH-USD',
            side: 'SHORT',
            size: '0.5',
            entryPrice: '2500',
            unrealizedPnl: '10',
          },
        ]),
      }),
    });

    const client = new HoldingsClient(makeAgent('polygon') as any);
    const result = await client.scan({
      chains: ['polygon', 'base', 'avalanche', 'arbitrum', 'hyperliquid', 'dydx'],
    });

    expect(result.holdings.some((holding) => holding.holdingType === 'native' && holding.chain === 'polygon')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'token' && holding.symbol === 'USDC' && holding.chain === 'polygon')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'vault' && holding.protocolId === 'yousd-vault')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'vault' && holding.protocolId === 'avantis')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'staking' && holding.protocolId === 'benqi')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'prediction' && holding.protocolId === 'polymarket')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'perp' && holding.protocolId === 'hyperliquid')).toBe(true);
    expect(result.holdings.some((holding) => holding.holdingType === 'perp' && holding.protocolId === 'dydx')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('includes Robinhood Chain in the default native-balance scan', async () => {
    const switchedChains: string[] = [];
    const makeAgent = (chain: string): any => ({
      address: '0x0fe61780bd5508b3C99e420662050e5560608cA4',
      provider: { getBalance: vi.fn().mockResolvedValue(0n) },
      getChainInfo: () => ({ id: 0, name: chain, currency: { symbol: 'ETH' } }),
      switchNetwork: (next: string) => {
        switchedChains.push(next);
        return makeAgent(next);
      },
      hyperliquid: vi.fn(),
      dydx: vi.fn(),
    });

    const client = new HoldingsClient(makeAgent('ethereum'));
    await client.scan({ include: ['native'] });

    expect(switchedChains).toContain('robinhood');
  });
});
