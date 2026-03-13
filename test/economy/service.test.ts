import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentServiceHost } from '../../src/economy/service';
import type { ServiceEndpoint } from '../../src/economy/service';

// We need a real ethers Wallet to create valid signatures for verification
import { Wallet } from 'ethers';

const AGENT_ADDRESS = '0xABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD';
const PAYER_PRIVATE_KEY = '0x' + 'bb'.repeat(32);
const payerWallet = new Wallet(PAYER_PRIVATE_KEY);

/** Create a valid x402 payment proof signed by the payer */
async function createProof(overrides?: Record<string, unknown>): Promise<string> {
  const payload = {
    facilitator: AGENT_ADDRESS,
    paymentAddress: AGENT_ADDRESS,
    amount: '0.01',
    currency: 'ETH',
    chainId: 8453,
    payer: payerWallet.address,
    timestamp: Date.now(),
    ...overrides,
  };
  const message = JSON.stringify(payload);
  const signature = await payerWallet.signMessage(message);
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
}

function makeEndpoint(overrides?: Partial<ServiceEndpoint>): ServiceEndpoint {
  return {
    path: '/audit',
    price: '0.01',
    currency: 'ETH',
    chainId: 8453,
    handler: async () => JSON.stringify({ result: 'audit complete' }),
    ...overrides,
  };
}

describe('AgentServiceHost', () => {
  let host: AgentServiceHost;

  beforeEach(() => {
    host = new AgentServiceHost(AGENT_ADDRESS);
  });

  describe('serve()', () => {
    it('should register an endpoint', () => {
      host.serve(makeEndpoint());
      expect(host.listEndpoints()).toHaveLength(1);
      expect(host.listEndpoints()[0].path).toBe('/audit');
    });

    it('should replace endpoint with same path', () => {
      host.serve(makeEndpoint({ price: '0.01' }));
      host.serve(makeEndpoint({ price: '0.05' }));
      expect(host.listEndpoints()).toHaveLength(1);
      expect(host.listEndpoints()[0].price).toBe('0.05');
    });

    it('should throw on missing required fields', () => {
      expect(() => host.serve(makeEndpoint({ path: '' }))).toThrow();
    });
  });

  describe('unserve()', () => {
    it('should remove an endpoint', () => {
      host.serve(makeEndpoint());
      expect(host.unserve('/audit')).toBe(true);
      expect(host.listEndpoints()).toHaveLength(0);
    });

    it('should return false for non-existent path', () => {
      expect(host.unserve('/nothing')).toBe(false);
    });
  });

  describe('handleRequest()', () => {
    beforeEach(() => {
      host.serve(makeEndpoint());
    });

    it('should return 404 for unknown paths', async () => {
      const res = await host.handleRequest('/unknown');
      expect(res.status).toBe(404);
    });

    it('should return 402 with requirements when no payment proof', async () => {
      const res = await host.handleRequest('/audit');
      expect(res.status).toBe(402);
      expect(res.headers['x-payment-requirements']).toBeDefined();

      const requirements = JSON.parse(res.headers['x-payment-requirements']);
      expect(requirements.paymentAddress).toBe(AGENT_ADDRESS);
      expect(requirements.amount).toBe('0.01');
      expect(requirements.currency).toBe('ETH');
      expect(requirements.chainId).toBe(8453);
    });

    it('should return 200 with content when valid payment proof', async () => {
      const proof = await createProof();
      const res = await host.handleRequest('/audit', undefined, proof);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result).toBe('audit complete');
    });

    it('should record payment after successful request', async () => {
      const proof = await createProof();
      await host.handleRequest('/audit', undefined, proof);
      expect(host.paymentCount).toBe(1);

      const revenue = host.getRevenue();
      expect(revenue.totalRequests).toBe(1);
      expect(revenue.byEndpoint['/audit'].count).toBe(1);
      expect(revenue.byEndpoint['/audit'].payments[0].from).toBe(payerWallet.address);
    });

    it('should return 403 for invalid proof format', async () => {
      const res = await host.handleRequest('/audit', undefined, 'not-valid-base64!!!');
      expect(res.status).toBe(403);
    });

    it('should return 403 when payment addressed to wrong agent', async () => {
      const proof = await createProof({ paymentAddress: '0x0000000000000000000000000000000000000000' });
      const res = await host.handleRequest('/audit', undefined, proof);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain('not addressed');
    });

    it('should return 403 for wrong chain', async () => {
      const proof = await createProof({ chainId: 1 });
      const res = await host.handleRequest('/audit', undefined, proof);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toContain('Wrong chain');
    });

    it('should pass body to handler', async () => {
      const handlerSpy = vi.fn().mockResolvedValue('{"ok":true}');
      host.serve(makeEndpoint({ handler: handlerSpy }));
      const proof = await createProof();
      await host.handleRequest('/audit', 'request-body', proof);
      expect(handlerSpy).toHaveBeenCalledWith('request-body');
    });
  });

  describe('getRevenue()', () => {
    it('should return empty summary with no payments', () => {
      const revenue = host.getRevenue();
      expect(revenue.totalRequests).toBe(0);
      expect(Object.keys(revenue.byEndpoint)).toHaveLength(0);
    });

    it('should group by endpoint', async () => {
      host.serve(makeEndpoint({ path: '/a' }));
      host.serve(makeEndpoint({ path: '/b' }));

      const proofA = await createProof();
      const proofB = await createProof();
      await host.handleRequest('/a', undefined, proofA);
      await host.handleRequest('/b', undefined, proofB);
      await host.handleRequest('/a', undefined, await createProof());

      const revenue = host.getRevenue();
      expect(revenue.totalRequests).toBe(3);
      expect(revenue.byEndpoint['/a'].count).toBe(2);
      expect(revenue.byEndpoint['/b'].count).toBe(1);
    });
  });
});
