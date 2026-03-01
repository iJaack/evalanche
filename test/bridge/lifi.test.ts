import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiFiClient, NATIVE_TOKEN } from '../../src/bridge/lifi';
import type { BridgeQuoteParams } from '../../src/bridge/lifi';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock signer
const mockSigner = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  sendTransaction: vi.fn(),
  signMessage: vi.fn(),
} as any;

const baseParams: BridgeQuoteParams = {
  fromChainId: 1,
  toChainId: 42161,
  fromToken: NATIVE_TOKEN,
  toToken: NATIVE_TOKEN,
  fromAmount: '0.1',
  fromAddress: '0x1234567890abcdef1234567890abcdef12345678',
};

describe('LiFiClient', () => {
  let client: LiFiClient;

  beforeEach(() => {
    client = new LiFiClient(mockSigner);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getQuote', () => {
    it('should fetch a quote from Li.Fi API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'test-quote-1',
          tool: 'across',
          action: {
            fromChainId: 1,
            toChainId: 42161,
            fromToken: { address: NATIVE_TOKEN },
            toToken: { address: NATIVE_TOKEN },
            fromAmount: '100000000000000000',
          },
          estimate: {
            toAmount: '99000000000000000',
            gasCosts: [{ amountUSD: '2.50' }],
            executionDuration: 120,
          },
          transactionRequest: {
            to: '0xbridge',
            data: '0x',
            value: '100000000000000000',
          },
        }),
      });

      const quote = await client.getQuote(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('li.quest/v1/quote');
      expect(callUrl).toContain('fromChain=1');
      expect(callUrl).toContain('toChain=42161');

      expect(quote.id).toBe('test-quote-1');
      expect(quote.tool).toBe('across');
      expect(quote.fromChainId).toBe(1);
      expect(quote.toChainId).toBe(42161);
      expect(quote.estimatedGas).toBe('2.50');
      expect(quote.estimatedTime).toBe(120);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      await expect(client.getQuote(baseParams)).rejects.toThrow('Li.Fi quote failed');
    });
  });

  describe('getRoutes', () => {
    it('should fetch routes from Li.Fi API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          routes: [
            {
              id: 'route-1',
              fromChainId: 1,
              toChainId: 42161,
              fromToken: { address: NATIVE_TOKEN },
              toToken: { address: NATIVE_TOKEN },
              fromAmount: '100000000000000000',
              toAmount: '99000000000000000',
              gasCostUSD: '2.50',
              steps: [
                {
                  tool: 'across',
                  action: { fromChainId: 1, toChainId: 42161 },
                  estimate: { executionDuration: 120 },
                },
              ],
            },
          ],
        }),
      });

      const routes = await client.getRoutes(baseParams);

      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe('route-1');
      expect(routes[0].tool).toBe('across');

      // Verify POST request
      expect(mockFetch.mock.calls[0][1]?.method).toBe('POST');
    });

    it('should return empty array when no routes available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ routes: [] }),
      });

      const routes = await client.getRoutes(baseParams);
      expect(routes).toHaveLength(0);
    });
  });

  describe('execute', () => {
    it('should send the transaction from the quote', async () => {
      mockSigner.sendTransaction.mockResolvedValueOnce({
        hash: '0xtxhash',
        wait: vi.fn().mockResolvedValueOnce({ status: 1 }),
      });

      const quote = {
        id: 'test',
        fromChainId: 1,
        toChainId: 42161,
        fromToken: NATIVE_TOKEN,
        toToken: NATIVE_TOKEN,
        fromAmount: '100000000000000000',
        toAmount: '99000000000000000',
        estimatedGas: '2.50',
        estimatedTime: 120,
        tool: 'across',
        rawRoute: {
          transactionRequest: {
            to: '0xbridge',
            data: '0xbridgedata',
            value: '100000000000000000',
          },
        },
      };

      const result = await client.execute(quote);

      expect(result.txHash).toBe('0xtxhash');
      expect(result.status).toBe('success');
      expect(mockSigner.sendTransaction).toHaveBeenCalledOnce();
    });

    it('should throw if no transactionRequest in quote', async () => {
      const quote = {
        id: 'test',
        fromChainId: 1,
        toChainId: 42161,
        fromToken: NATIVE_TOKEN,
        toToken: NATIVE_TOKEN,
        fromAmount: '100000000000000000',
        toAmount: '99000000000000000',
        estimatedGas: '2.50',
        estimatedTime: 120,
        tool: 'across',
        rawRoute: {},
      };

      await expect(client.execute(quote)).rejects.toThrow('No transaction request found');
    });
  });

  describe('NATIVE_TOKEN', () => {
    it('should be the zero address', () => {
      expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000');
    });
  });
});
