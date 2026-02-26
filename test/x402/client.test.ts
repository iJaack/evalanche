import { describe, it, expect, vi, beforeEach } from 'vitest';
import { X402Client } from '../../src/x402/client';
import { X402Facilitator } from '../../src/x402/facilitator';
import { EvalancheError, EvalancheErrorCode } from '../../src/utils/errors';
import { Wallet, JsonRpcProvider } from 'ethers';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('X402Client', () => {
  let wallet: Wallet;
  let client: X402Client;

  beforeEach(() => {
    vi.clearAllMocks();
    const provider = new JsonRpcProvider('http://localhost:8545');
    wallet = new Wallet(TEST_PRIVATE_KEY, provider);
    client = new X402Client(wallet);
  });

  describe('parsePaymentRequirements', () => {
    it('should parse requirements from x-payment-requirements header', () => {
      const requirements = {
        facilitator: '0x1234',
        paymentAddress: '0x5678',
        amount: '0.01',
        currency: 'AVAX',
        chainId: 43114,
      };

      const headers = new Headers({
        'x-payment-requirements': JSON.stringify(requirements),
      });

      const parsed = X402Client.parsePaymentRequirements(headers);
      expect(parsed).toEqual(requirements);
    });

    it('should parse requirements from x-402-requirements header', () => {
      const requirements = {
        facilitator: '0x1234',
        paymentAddress: '0x5678',
        amount: '0.005',
        currency: 'AVAX',
        chainId: 43113,
      };

      const headers = new Headers({
        'x-402-requirements': JSON.stringify(requirements),
      });

      const parsed = X402Client.parsePaymentRequirements(headers);
      expect(parsed).toEqual(requirements);
    });

    it('should throw if no requirements header found', () => {
      const headers = new Headers();
      expect(() => X402Client.parsePaymentRequirements(headers)).toThrow(EvalancheError);
    });

    it('should throw if requirements header is invalid JSON', () => {
      const headers = new Headers({
        'x-payment-requirements': 'not-json',
      });
      expect(() => X402Client.parsePaymentRequirements(headers)).toThrow(EvalancheError);
    });
  });

  describe('payAndFetch', () => {
    it('should return response directly if not 402', async () => {
      const mockResponse = new Response('OK', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      const result = await client.payAndFetch('https://example.com/api', {
        maxPayment: '0.01',
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe('OK');
    });

    it('should handle 402 and retry with payment', async () => {
      const requirements = {
        facilitator: '0x1234',
        paymentAddress: '0x5678',
        amount: '0.005',
        currency: 'AVAX',
        chainId: 43114,
      };

      const response402 = new Response('Payment Required', {
        status: 402,
        headers: { 'x-payment-requirements': JSON.stringify(requirements) },
      });
      const response200 = new Response('Protected Content', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(response402)
        .mockResolvedValueOnce(response200);

      const result = await client.payAndFetch('https://example.com/api', {
        maxPayment: '0.01',
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe('Protected Content');
      expect(result.paymentHash).toBeDefined();
    });

    it('should throw if payment exceeds maxPayment', async () => {
      const requirements = {
        facilitator: '0x1234',
        paymentAddress: '0x5678',
        amount: '1.0',
        currency: 'AVAX',
        chainId: 43114,
      };

      const response402 = new Response('Payment Required', {
        status: 402,
        headers: { 'x-payment-requirements': JSON.stringify(requirements) },
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response402);

      await expect(
        client.payAndFetch('https://example.com/api', { maxPayment: '0.01' }),
      ).rejects.toThrow(EvalancheError);
    });
  });
});

describe('X402Facilitator', () => {
  describe('validatePaymentLimit', () => {
    it('should return true when payment is within limit', () => {
      expect(
        X402Facilitator.validatePaymentLimit(
          { facilitator: '', paymentAddress: '', amount: '0.005', currency: 'AVAX', chainId: 43114 },
          '0.01',
        ),
      ).toBe(true);
    });

    it('should return true when payment equals limit', () => {
      expect(
        X402Facilitator.validatePaymentLimit(
          { facilitator: '', paymentAddress: '', amount: '0.01', currency: 'AVAX', chainId: 43114 },
          '0.01',
        ),
      ).toBe(true);
    });

    it('should return false when payment exceeds limit', () => {
      expect(
        X402Facilitator.validatePaymentLimit(
          { facilitator: '', paymentAddress: '', amount: '0.02', currency: 'AVAX', chainId: 43114 },
          '0.01',
        ),
      ).toBe(false);
    });
  });
});
