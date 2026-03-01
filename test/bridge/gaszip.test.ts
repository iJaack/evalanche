import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GasZipClient } from '../../src/bridge/gaszip';
import type { GasZipParams } from '../../src/bridge/gaszip';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock signer
const mockSigner = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  sendTransaction: vi.fn(),
} as any;

const baseParams: GasZipParams = {
  fromChainId: 1,
  toChainId: 42161,
  toAddress: '0x1234567890abcdef1234567890abcdef12345678',
  destinationGasAmount: '0.01',
};

describe('GasZipClient', () => {
  let client: GasZipClient;

  beforeEach(() => {
    client = new GasZipClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getQuote', () => {
    it('should fetch a quote from Gas.zip API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quote: {
            fromToken: 'ETH',
            fromAmount: '0.005',
            toAmount: '0.01',
            depositAddress: '0xgaszipdepositaddress',
            estimatedTime: 30,
          },
        }),
      });

      const quote = await client.getQuote(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('gas.zip');
      expect(callUrl).toContain('fromChainId=1');
      expect(callUrl).toContain('toChainId=42161');

      expect(quote.fromChainId).toBe(1);
      expect(quote.toChainId).toBe(42161);
      expect(quote.depositAddress).toBe('0xgaszipdepositaddress');
      expect(quote.fromAmount).toBe('0.005');
      expect(quote.toAmount).toBe('0.01');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(client.getQuote(baseParams)).rejects.toThrow('Gas.zip quote failed');
    });
  });

  describe('fundGas', () => {
    it('should get quote and send deposit transaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quote: {
            fromToken: 'ETH',
            fromAmount: '0.005',
            toAmount: '0.01',
            depositAddress: '0xgaszipdepositaddress',
            estimatedTime: 30,
          },
        }),
      });

      mockSigner.sendTransaction.mockResolvedValueOnce({
        hash: '0xfundhash',
        wait: vi.fn().mockResolvedValueOnce({ status: 1 }),
      });

      const result = await client.fundGas(baseParams, mockSigner);

      expect(result.txHash).toBe('0xfundhash');
      expect(mockSigner.sendTransaction).toHaveBeenCalledOnce();
      const txCall = mockSigner.sendTransaction.mock.calls[0][0];
      expect(txCall.to).toBe('0xgaszipdepositaddress');
    });

    it('should throw if deposit address is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quote: {
            fromToken: 'ETH',
            fromAmount: '0.005',
            toAmount: '0.01',
            depositAddress: '',
            estimatedTime: 30,
          },
        }),
      });

      await expect(client.fundGas(baseParams, mockSigner)).rejects.toThrow('deposit address');
    });
  });
});
