import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiFiClient, NATIVE_TOKEN } from '../../src/bridge/lifi';
import type { BridgeQuoteParams } from '../../src/bridge/lifi';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock signer
const mockSigner = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  getAddress: vi.fn().mockResolvedValue('0x1234567890abcdef1234567890abcdef12345678'),
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

    it('should flatten CAIP-style EVM sender addresses for Base to Polygon USDC quotes', async () => {
      const walletAddress = '0x0fE61780BD5508b3C99E420662050E5560608cA4';
      const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      const polygonNativeUsdc = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'base-polygon-usdc',
          tool: 'across',
          action: {
            fromChainId: 8453,
            toChainId: 137,
            fromToken: { address: baseUsdc },
            toToken: { address: polygonNativeUsdc },
            fromAmount: '5000000',
          },
          estimate: {
            toAmount: '4990000',
            gasCosts: [{ amountUSD: '0.02' }],
            executionDuration: 45,
          },
        }),
      });

      await client.getQuote({
        fromChainId: 8453,
        toChainId: 137,
        fromToken: baseUsdc,
        toToken: polygonNativeUsdc,
        fromAmount: '5',
        fromDecimals: 6,
        fromAddress: `eip155:8453:${walletAddress}`,
      });

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(callUrl.searchParams.get('fromChain')).toBe('8453');
      expect(callUrl.searchParams.get('toChain')).toBe('137');
      expect(callUrl.searchParams.get('fromAmount')).toBe('5000000');
      expect(callUrl.searchParams.get('fromAddress')).toBe(walletAddress.toLowerCase());
      expect(callUrl.searchParams.get('toAddress')).toBe(walletAddress.toLowerCase());
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      await expect(client.getQuote(baseParams)).rejects.toThrow('Li.Fi quote failed');
    });

    it('should apply the minimum slippage strategy defaults', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'quote-low-slip',
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
        }),
      });

      await client.getQuote({
        ...baseParams,
        routeStrategy: 'minimum_slippage',
      });

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(callUrl.searchParams.get('slippage')).toBe('0.005');
      expect(callUrl.searchParams.get('preset')).toBe('stablecoin');
      expect(callUrl.searchParams.get('maxPriceImpact')).toBe('0.05');
    });

    it('should apply the minimum execution time strategy defaults', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'quote-fast-response',
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
        }),
      });

      await client.getQuote({
        ...baseParams,
        routeStrategy: 'minimum_execution_time',
      });

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(callUrl.searchParams.get('skipSimulation')).toBe('true');
      expect(callUrl.searchParams.getAll('swapStepTimingStrategies')).toEqual(['minWaitTime-200-1-200']);
      expect(callUrl.searchParams.getAll('routeTimingStrategies')).toEqual(['minWaitTime-200-1-200']);
    });

    it('should support explicit fastest route ordering and timing overrides', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'quote-fastest',
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
        }),
      });

      await client.getQuote({
        ...baseParams,
        routeOrder: 'FASTEST',
        swapStepTimingStrategies: [{
          minWaitTimeMs: 500,
          startingExpectedResults: 2,
          reduceEveryMs: 250,
        }],
      });

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(callUrl.searchParams.get('order')).toBe('FASTEST');
      expect(callUrl.searchParams.getAll('swapStepTimingStrategies')).toEqual(['minWaitTime-500-2-250']);
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

    it('should pass route strategy options into advanced route requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ routes: [] }),
      });

      await client.getRoutes({
        ...baseParams,
        routeStrategy: 'minimum_execution_time',
        routeOrder: 'FASTEST',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string) as {
        options: Record<string, unknown>;
      };

      expect(body.options.order).toBe('FASTEST');
      expect(body.options.skipSimulation).toBe(true);
      expect(body.options.swapStepTimingStrategies).toEqual(['minWaitTime-200-1-200']);
      expect(body.options.routeTimingStrategies).toEqual(['minWaitTime-200-1-200']);
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

    it('should return a detailed execution envelope for cross-chain transfers', async () => {
      mockSigner.sendTransaction.mockResolvedValueOnce({
        hash: '0xtxhash',
        wait: vi.fn().mockResolvedValueOnce({ status: 1 }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'PENDING',
          substatus: 'WAIT_SOURCE_CONFIRMATIONS',
        }),
      });

      const quote = {
        id: 'test-route',
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

      const result = await client.executeDetailed(quote);

      expect(result.txHash).toBe('0xtxhash');
      expect(result.routeId).toBe('test-route');
      expect(result.transferStatus?.status).toBe('PENDING');
      expect(result.warnings).toContain('No provider available on signer for Li.Fi balance verification.');
    });
  });

  describe('NATIVE_TOKEN', () => {
    it('should be the zero address', () => {
      expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000');
    });
  });

  describe('checkTransferStatus', () => {
    it('should return DONE status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'DONE',
          substatus: 'COMPLETED',
          receiving: { txHash: '0xabc', amount: '1000', token: '0xtoken', chainId: 42161 },
        }),
      });

      const result = await client.checkTransferStatus({
        txHash: '0xtx',
        fromChainId: 1,
        toChainId: 42161,
      });

      expect(result.status).toBe('DONE');
      expect(result.receiving?.txHash).toBe('0xabc');
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('li.quest/v1/status');
      expect(callUrl).toContain('txHash=0xtx');
    });

    it('should return PENDING status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'PENDING', substatus: 'BRIDGE_NOT_AVAILABLE' }),
      });

      const result = await client.checkTransferStatus({
        txHash: '0xtx',
        fromChainId: 1,
        toChainId: 42161,
        bridge: 'across',
      });

      expect(result.status).toBe('PENDING');
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('bridge=across');
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });

      await expect(client.checkTransferStatus({
        txHash: '0xtx',
        fromChainId: 1,
        toChainId: 42161,
      })).rejects.toThrow('Li.Fi status check failed');
    });
  });

  describe('getSwapQuote', () => {
    it('should return a quote for same-chain swap', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'swap-1',
          tool: '1inch',
          action: {
            fromChainId: 1,
            toChainId: 1,
            fromToken: { address: '0xA' },
            toToken: { address: '0xB' },
            fromAmount: '1000000000000000000',
          },
          estimate: {
            toAmount: '2000000000',
            gasCosts: [{ amountUSD: '1.00' }],
            executionDuration: 30,
          },
        }),
      });

      const quote = await client.getSwapQuote({
        ...baseParams,
        fromChainId: 1,
        toChainId: 1,
      });

      expect(quote.id).toBe('swap-1');
      expect(quote.tool).toBe('1inch');
    });

    it('should throw when chains differ', async () => {
      await expect(client.getSwapQuote({
        ...baseParams,
        fromChainId: 1,
        toChainId: 42161,
      })).rejects.toThrow('getSwapQuote requires same-chain');
    });
  });

  describe('getTokens', () => {
    it('should fetch tokens for multiple chains', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tokens: {
            '1': [{ address: '0xA', symbol: 'USDC', decimals: 6, name: 'USD Coin', chainId: 1 }],
            '42161': [{ address: '0xB', symbol: 'ARB', decimals: 18, name: 'Arbitrum', chainId: 42161 }],
          },
        }),
      });

      const tokens = await client.getTokens([1, 42161]);

      expect(tokens['1']).toHaveLength(1);
      expect(tokens['42161']).toHaveLength(1);
      expect(tokens['1'][0].symbol).toBe('USDC');
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('chains=1,42161');
    });
  });

  describe('getToken', () => {
    it('should fetch a single token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ address: '0xA', symbol: 'USDC', decimals: 6, name: 'USD Coin', chainId: 1, priceUSD: '1.00' }),
      });

      const token = await client.getToken(1, '0xA');

      expect(token.symbol).toBe('USDC');
      expect(token.priceUSD).toBe('1.00');
    });

    it('should throw on error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      await expect(client.getToken(1, '0xBAD')).rejects.toThrow('Li.Fi get token failed');
    });
  });

  describe('getChains', () => {
    it('should fetch all chains', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chains: [
            { id: 1, key: 'eth', name: 'Ethereum', chainType: 'EVM' },
            { id: 42161, key: 'arb', name: 'Arbitrum', chainType: 'EVM' },
          ],
        }),
      });

      const chains = await client.getChains();

      expect(chains).toHaveLength(2);
      expect(chains[0].key).toBe('eth');
    });

    it('should filter by chain types', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chains: [{ id: 1, key: 'eth', name: 'Ethereum', chainType: 'EVM' }],
        }),
      });

      const chains = await client.getChains(['EVM']);

      expect(chains).toHaveLength(1);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('chainTypes=EVM');
    });
  });

  describe('getTools', () => {
    it('should fetch bridges and exchanges', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bridges: [{ key: 'across', name: 'Across' }],
          exchanges: [{ key: '1inch', name: '1inch' }],
        }),
      });

      const tools = await client.getTools();

      expect(tools.bridges).toHaveLength(1);
      expect(tools.exchanges).toHaveLength(1);
      expect(tools.bridges[0].key).toBe('across');
    });
  });

  describe('getGasPrices', () => {
    it('should fetch gas prices', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ '1': { maxFeePerGas: '30000000000' }, '42161': { gasPrice: '100000000' } }),
      });

      const prices = await client.getGasPrices();

      expect(prices['1']).toBeDefined();
      expect(prices['42161']).toBeDefined();
    });
  });

  describe('getGasSuggestion', () => {
    it('should fetch gas suggestion for a chain', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ standard: '20000000000', fast: '30000000000', slow: '10000000000' }),
      });

      const suggestion = await client.getGasSuggestion(1);

      expect(suggestion.standard).toBe('20000000000');
      expect(suggestion.fast).toBe('30000000000');
      expect(suggestion.slow).toBe('10000000000');
    });

    it('should throw on error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid chain',
      });

      await expect(client.getGasSuggestion(999999)).rejects.toThrow('Li.Fi gas suggestion failed');
    });

    it('should normalize the nested gas suggestion payload shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          recommended: { amount: '20000000000' },
          limit: { amount: '30000000000' },
          fromAmount: '21000',
          available: true,
        }),
      });

      const suggestion = await client.getGasSuggestion(1);

      expect(suggestion.standard).toBe('20000000000');
      expect(suggestion.fast).toBe('30000000000');
      expect(suggestion.slow).toBe('20000000000');
      expect(suggestion.available).toBe('true');
      expect(suggestion.fromAmount).toBe('21000');
    });
  });

  describe('getConnections', () => {
    it('should fetch connections between chains', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connections: [{
            fromChainId: 1,
            toChainId: 42161,
            fromTokens: [{ address: '0xA', symbol: 'USDC', decimals: 6, name: 'USD Coin', chainId: 1 }],
            toTokens: [{ address: '0xB', symbol: 'USDC', decimals: 6, name: 'USD Coin', chainId: 42161 }],
          }],
        }),
      });

      const connections = await client.getConnections({ fromChainId: 1, toChainId: 42161 });

      expect(connections).toHaveLength(1);
      expect(connections[0].fromChainId).toBe(1);
      expect(connections[0].toChainId).toBe(42161);
    });

    it('should pass token filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [] }),
      });

      await client.getConnections({ fromChainId: 1, toChainId: 42161, fromToken: '0xA', toToken: '0xB' });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('fromToken=0xA');
      expect(callUrl).toContain('toToken=0xB');
    });
  });
});
