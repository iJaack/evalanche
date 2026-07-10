import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GasZipClient } from '../../src/bridge/gaszip';
import type { GasZipParams } from '../../src/bridge/gaszip';
import { EvalancheErrorCode } from '../../src/utils/errors';

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
    it('should fetch a quote from LI.FI Gas.zip routing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tool: 'gasZipBridge',
          action: {
            fromToken: { symbol: 'ETH' },
          },
          estimate: {
            toAmount: '10000000000000000',
            executionDuration: 30,
          },
          transactionRequest: {
            to: '0xgaszipdepositaddress',
            value: '10000000000000000',
          },
        }),
      });

      const quote = await client.getQuote(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(callUrl.toString()).toContain('li.quest/v1/quote');
      expect(callUrl.searchParams.get('fromChain')).toBe('1');
      expect(callUrl.searchParams.get('toChain')).toBe('42161');
      expect(callUrl.searchParams.get('allowBridges')).toBe('gasZipBridge');

      expect(quote.fromChainId).toBe(1);
      expect(quote.toChainId).toBe(42161);
      expect(quote.depositAddress).toBe('0xgaszipdepositaddress');
      expect(quote.fromAmount).toBe('0.01');
      expect(quote.toAmount).toBe('0.01');
    });

    it('should reject Robinhood Chain before requesting a quote', async () => {
      const error = await client.getQuote({
        ...baseParams,
        toChainId: 4663,
      }).catch((caught) => caught);

      expect(error).toMatchObject({ code: EvalancheErrorCode.GAS_ZIP_ERROR });
      expect(error.message).toContain('Robinhood Chain (4663)');
      expect(mockFetch).not.toHaveBeenCalled();
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
          tool: 'gasZipBridge',
          action: {
            fromToken: { symbol: 'ETH' },
          },
          estimate: {
            toAmount: '10000000000000000',
            executionDuration: 30,
          },
          transactionRequest: {
            to: '0xgaszipdepositaddress',
            value: '10000000000000000',
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
          tool: 'gasZipBridge',
          action: {
            fromToken: { symbol: 'ETH' },
          },
          estimate: {
            toAmount: '10000000000000000',
            executionDuration: 30,
          },
          transactionRequest: {
            to: '',
            value: '10000000000000000',
          },
        }),
      });

      await expect(client.fundGas(baseParams, mockSigner)).rejects.toThrow('deposit address');
    });
  });
});
