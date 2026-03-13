import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoveryClient } from '../../src/economy/discovery';
import { EvalancheError } from '../../src/utils/errors';
import type { AgentService } from '../../src/economy/types';
import type { JsonRpcProvider } from 'ethers';

/** Mock provider — discovery doesn't need real RPC for most tests */
function mockProvider(): JsonRpcProvider {
  return {} as JsonRpcProvider;
}

function makeService(overrides?: Partial<AgentService>): AgentService {
  return {
    agentId: '1599',
    capability: 'code-audit',
    description: 'Smart contract security audit',
    endpoint: 'https://agent1599.example.com/audit',
    pricePerCall: '10000000000000000', // 0.01 ETH
    chainId: 8453,
    registeredAt: Date.now(),
    ...overrides,
  };
}

describe('DiscoveryClient', () => {
  let client: DiscoveryClient;

  beforeEach(() => {
    client = new DiscoveryClient(mockProvider());
  });

  describe('register()', () => {
    it('should register a service', () => {
      client.register(makeService());
      expect(client.agentCount).toBe(1);
      expect(client.serviceCount).toBe(1);
    });

    it('should register multiple services for same agent', () => {
      client.register(makeService({ capability: 'code-audit' }));
      client.register(makeService({ capability: 'token-analysis' }));
      expect(client.agentCount).toBe(1);
      expect(client.serviceCount).toBe(2);
    });

    it('should replace service with same capability', () => {
      client.register(makeService({ pricePerCall: '100' }));
      client.register(makeService({ pricePerCall: '200' }));
      expect(client.serviceCount).toBe(1);
      const all = client.listAll();
      expect(all[0].pricePerCall).toBe('200');
    });

    it('should register services for different agents', () => {
      client.register(makeService({ agentId: '1' }));
      client.register(makeService({ agentId: '2' }));
      expect(client.agentCount).toBe(2);
      expect(client.serviceCount).toBe(2);
    });

    it('should throw on missing required fields', () => {
      expect(() => client.register(makeService({ agentId: '' }))).toThrow(EvalancheError);
      expect(() => client.register(makeService({ capability: '' }))).toThrow(EvalancheError);
      expect(() => client.register(makeService({ endpoint: '' }))).toThrow(EvalancheError);
    });
  });

  describe('unregister()', () => {
    it('should remove a service', () => {
      client.register(makeService());
      const removed = client.unregister('1599', 'code-audit');
      expect(removed).toBe(true);
      expect(client.serviceCount).toBe(0);
    });

    it('should return false for non-existent service', () => {
      expect(client.unregister('9999', 'nothing')).toBe(false);
    });

    it('should only remove the specified capability', () => {
      client.register(makeService({ capability: 'audit' }));
      client.register(makeService({ capability: 'analysis' }));
      client.unregister('1599', 'audit');
      expect(client.serviceCount).toBe(1);
      expect(client.listAll()[0].capability).toBe('analysis');
    });
  });

  describe('search()', () => {
    beforeEach(() => {
      client.register(makeService({ agentId: '1', capability: 'code-audit', pricePerCall: '100', chainId: 8453 }));
      client.register(makeService({ agentId: '2', capability: 'token-analysis', pricePerCall: '200', chainId: 43114 }));
      client.register(makeService({ agentId: '3', capability: 'smart-audit', pricePerCall: '50', chainId: 8453, tags: ['solidity', 'defi'] }));
    });

    it('should return all services with empty query', async () => {
      const results = await client.search();
      expect(results).toHaveLength(3);
    });

    it('should filter by capability (substring match)', async () => {
      const results = await client.search({ capability: 'audit' });
      expect(results).toHaveLength(2); // code-audit and smart-audit
    });

    it('should be case-insensitive for capability', async () => {
      const results = await client.search({ capability: 'AUDIT' });
      expect(results).toHaveLength(2);
    });

    it('should filter by chain', async () => {
      const results = await client.search({ chainIds: [8453] });
      expect(results).toHaveLength(2);
    });

    it('should filter by max price', async () => {
      const results = await client.search({ maxPrice: '100' });
      expect(results).toHaveLength(2); // price 50 and 100
    });

    it('should filter by tags', async () => {
      const results = await client.search({ tags: ['solidity'] });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('3');
    });

    it('should require ALL tags', async () => {
      const results = await client.search({ tags: ['solidity', 'nft'] });
      expect(results).toHaveLength(0); // no service has both
    });

    it('should sort by price ascending', async () => {
      const results = await client.search();
      expect(results[0].pricePerCall).toBe('50');
      expect(results[1].pricePerCall).toBe('100');
      expect(results[2].pricePerCall).toBe('200');
    });

    it('should respect limit', async () => {
      const results = await client.search({ limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('should combine filters (AND logic)', async () => {
      const results = await client.search({ capability: 'audit', chainIds: [8453], maxPrice: '60' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('3'); // smart-audit, chain 8453, price 50
    });
  });

  describe('resolve()', () => {
    it('should return services even if identity resolution fails', async () => {
      client.register(makeService({ agentId: '1599' }));
      const profile = await client.resolve('1599');
      expect(profile.agentId).toBe('1599');
      expect(profile.services).toHaveLength(1);
      // Identity resolution will fail (mock provider), but profile still returns
      expect(profile.trustLevel).toBe('unknown');
    });

    it('should return empty services for unregistered agent', async () => {
      const profile = await client.resolve('9999');
      expect(profile.services).toHaveLength(0);
    });
  });

  describe('listAll()', () => {
    it('should return all services from all agents', () => {
      client.register(makeService({ agentId: '1', capability: 'a' }));
      client.register(makeService({ agentId: '2', capability: 'b' }));
      expect(client.listAll()).toHaveLength(2);
    });
  });
});
