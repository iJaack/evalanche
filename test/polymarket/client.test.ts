import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalancheError } from '../../src/utils/errors';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock ethers Contract
const mockBalanceOf = vi.fn();
const mockAllowance = vi.fn();
const mockApprove = vi.fn();
const mockRedeemPositions = vi.fn();
const mockUsdcBalanceOf = vi.fn();

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');
  return {
    ...actual as Record<string, unknown>,
    Contract: vi.fn().mockImplementation((_address: string, _abi: string[]) => ({
      balanceOf: mockBalanceOf,
      allowance: mockAllowance,
      approve: mockApprove,
      redeemPositions: mockRedeemPositions,
    })),
  };
});

import { PolymarketClient } from '../../src/polymarket/client';

// Create mock wallet & provider
const mockWallet = {
  getAddress: vi.fn().mockResolvedValue('0x1234567890abcdef1234567890abcdef12345678'),
  signTypedData: vi.fn().mockResolvedValue('0xsignature'),
} as unknown as ConstructorParameters<typeof PolymarketClient>[0];

const mockProvider = {
  getBalance: vi.fn(),
} as unknown as ConstructorParameters<typeof PolymarketClient>[1];

function jsonResponse(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) };
}

describe('PolymarketClient', () => {
  let client: PolymarketClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PolymarketClient(mockWallet, mockProvider);
  });

  describe('searchMarkets', () => {
    it('should parse outcomePrices from JSON string', async () => {
      const markets = [{
        conditionId: '0xabc',
        question: 'Will BTC hit 100k?',
        endDate: '2025-12-31',
        outcomes: '["Yes","No"]',
        outcomePrices: '[0.65,0.35]',
        volume: 1000000,
        liquidity: 500000,
        active: true,
        closed: false,
      }];
      mockFetch.mockResolvedValueOnce(jsonResponse(markets));

      const result = await client.searchMarkets('bitcoin');
      expect(result).toHaveLength(1);
      expect(result[0].outcomePrices).toEqual([0.65, 0.35]);
      expect(result[0].outcomes).toEqual(['Yes', 'No']);
      expect(result[0].conditionId).toBe('0xabc');
    });
  });

  describe('getMarket', () => {
    it('should return first result', async () => {
      const markets = [{
        conditionId: '0xabc',
        question: 'Test?',
        endDate: '2025-12-31',
        outcomes: ['Yes', 'No'],
        outcomePrices: [0.5, 0.5],
        volume: 100,
        liquidity: 50,
        active: true,
        closed: false,
      }];
      mockFetch.mockResolvedValueOnce(jsonResponse(markets));

      const result = await client.getMarket('0xabc');
      expect(result.conditionId).toBe('0xabc');
      expect(result.question).toBe('Test?');
    });

    it('should throw POLYMARKET_NOT_FOUND for empty results', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      await expect(client.getMarket('0xnonexistent')).rejects.toThrow('Market not found');
    });
  });

  describe('getPositions', () => {
    it('should return empty array when on-chain balance is zero', async () => {
      const positions = [{
        tokenId: '12345',
        conditionId: '0xabc',
        question: 'Test?',
        outcome: 'Yes',
        currentPrice: 0.65,
      }];
      mockFetch.mockResolvedValueOnce(jsonResponse(positions));
      mockBalanceOf.mockResolvedValueOnce(0n);

      const result = await client.getPositions('0x1234');
      expect(result).toHaveLength(0);
    });
  });

  describe('buy', () => {
    it('should throw POLYMARKET_INSUFFICIENT_GAS if MATIC balance is zero', async () => {
      // Mock getMarket
      const markets = [{
        conditionId: '0xabc',
        question: 'Test?',
        endDate: '2025-12-31',
        outcomes: ['YES', 'NO'],
        outcomePrices: [0.5, 0.5],
        volume: 100,
        liquidity: 50,
        active: true,
        closed: false,
        tokens: [{ outcome: 'YES', token_id: 'tok1' }, { outcome: 'NO', token_id: 'tok2' }],
      }];
      // First fetch: getMarket
      mockFetch.mockResolvedValueOnce(jsonResponse(markets));
      // Second fetch: getOrderbook
      mockFetch.mockResolvedValueOnce(jsonResponse({
        bids: [{ price: '0.48', size: '100' }],
        asks: [{ price: '0.52', size: '100' }],
      }));
      // MATIC balance = 0
      (mockProvider.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0n);

      await expect(client.buy('0xabc', 'YES', '10')).rejects.toThrow('Zero MATIC balance');
    });
  });

  describe('redeem', () => {
    it('should throw POLYMARKET_MARKET_CLOSED if market is still active', async () => {
      const markets = [{
        conditionId: '0xabc',
        question: 'Test?',
        endDate: '2025-12-31',
        outcomes: ['Yes', 'No'],
        outcomePrices: [0.5, 0.5],
        volume: 100,
        liquidity: 50,
        active: true,
        closed: false,
      }];
      mockFetch.mockResolvedValueOnce(jsonResponse(markets));

      await expect(client.redeem('0xabc')).rejects.toThrow('Market is still active');
    });
  });
});
