import { describe, it, expect, beforeEach } from 'vitest';
import { NegotiationClient } from '../../src/economy/negotiation';
import { EvalancheError } from '../../src/utils/errors';

describe('NegotiationClient', () => {
  let client: NegotiationClient;

  beforeEach(() => {
    client = new NegotiationClient();
  });

  describe('propose()', () => {
    it('should create a proposal', () => {
      const id = client.propose({
        fromAgentId: 'A', toAgentId: 'B', task: 'audit', price: '100', chainId: 8453,
      });
      expect(id).toMatch(/^prop_/);
      const proposal = client.get(id);
      expect(proposal?.status).toBe('pending');
      expect(proposal?.task).toBe('audit');
      expect(proposal?.price).toBe('100');
    });

    it('should throw on missing fields', () => {
      expect(() => client.propose({
        fromAgentId: '', toAgentId: 'B', task: 'x', price: '100', chainId: 1,
      })).toThrow(EvalancheError);
    });

    it('should assign unique IDs', () => {
      const id1 = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '1', chainId: 1 });
      const id2 = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'y', price: '2', chainId: 1 });
      expect(id1).not.toBe(id2);
    });
  });

  describe('accept()', () => {
    it('should accept a pending proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      const result = client.accept(id);
      expect(result.status).toBe('accepted');
    });

    it('should throw on non-existent proposal', () => {
      expect(() => client.accept('prop_999')).toThrow(EvalancheError);
    });

    it('should throw on already rejected proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      client.reject(id);
      expect(() => client.accept(id)).toThrow();
    });
  });

  describe('counter()', () => {
    it('should counter with a new price', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      const result = client.counter(id, '150');
      expect(result.status).toBe('countered');
      expect(result.counterPrice).toBe('150');
    });

    it('should allow accepting a countered proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      client.counter(id, '150');
      const accepted = client.accept(id);
      expect(accepted.status).toBe('accepted');
    });

    it('should return counter price as agreed price', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      client.counter(id, '150');
      expect(client.getAgreedPrice(id)).toBe('150');
    });
  });

  describe('reject()', () => {
    it('should reject a pending proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      const result = client.reject(id);
      expect(result.status).toBe('rejected');
    });

    it('should throw when rejecting an already settled proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      client.accept(id);
      client.markSettled(id);
      expect(() => client.reject(id)).toThrow();
    });
  });

  describe('markSettled()', () => {
    it('should settle an accepted proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      client.accept(id);
      const result = client.markSettled(id);
      expect(result.status).toBe('settled');
    });

    it('should throw on non-accepted proposal', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      expect(() => client.markSettled(id)).toThrow();
    });
  });

  describe('expiry', () => {
    it('should expire proposals after TTL', () => {
      const id = client.propose({
        fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1,
        ttlMs: -1, // Already expired (negative TTL = expiresAt is in the past)
      });
      const proposal = client.get(id);
      expect(proposal?.status).toBe('expired');
    });

    it('should throw when accepting expired proposal', () => {
      const id = client.propose({
        fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1,
        ttlMs: -1,
      });
      expect(() => client.accept(id)).toThrow(/expired/);
    });
  });

  describe('list()', () => {
    it('should list all proposals', () => {
      client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '1', chainId: 1 });
      client.propose({ fromAgentId: 'A', toAgentId: 'C', task: 'y', price: '2', chainId: 1 });
      expect(client.list()).toHaveLength(2);
    });

    it('should filter by status', () => {
      const id1 = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '1', chainId: 1 });
      client.propose({ fromAgentId: 'A', toAgentId: 'C', task: 'y', price: '2', chainId: 1 });
      client.accept(id1);
      expect(client.list({ status: 'accepted' })).toHaveLength(1);
      expect(client.list({ status: 'pending' })).toHaveLength(1);
    });

    it('should filter by agent', () => {
      client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '1', chainId: 1 });
      client.propose({ fromAgentId: 'C', toAgentId: 'D', task: 'y', price: '2', chainId: 1 });
      expect(client.list({ agentId: 'A' })).toHaveLength(1);
      expect(client.list({ agentId: 'B' })).toHaveLength(1); // B is target
      expect(client.list({ agentId: 'Z' })).toHaveLength(0);
    });
  });

  describe('getAgreedPrice()', () => {
    it('should return original price when no counter', () => {
      const id = client.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '100', chainId: 1 });
      expect(client.getAgreedPrice(id)).toBe('100');
    });
  });
});
