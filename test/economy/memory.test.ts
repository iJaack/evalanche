import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMemory } from '../../src/economy/memory';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AgentMemory', () => {
  let memory: AgentMemory;

  beforeEach(() => {
    memory = new AgentMemory(); // in-memory mode
  });

  describe('record()', () => {
    it('should record an interaction and return an ID', () => {
      const id = memory.record({
        type: 'payment_sent',
        counterpartyId: 'agent-42',
        amount: '1000000000000000000',
        chainId: 8453,
      });
      expect(id).toMatch(/^ix_/);
      expect(memory.interactionCount).toBe(1);
    });

    it('should record multiple interactions', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'A', amount: '100' });
      memory.record({ type: 'payment_received', counterpartyId: 'B', amount: '200' });
      memory.record({ type: 'negotiation_proposed', counterpartyId: 'A' });
      expect(memory.interactionCount).toBe(3);
    });

    it('should assign unique IDs', () => {
      const id1 = memory.record({ type: 'payment_sent', counterpartyId: 'A' });
      const id2 = memory.record({ type: 'payment_sent', counterpartyId: 'A' });
      expect(id1).not.toBe(id2);
    });
  });

  describe('query()', () => {
    beforeEach(() => {
      memory.record({ type: 'payment_sent', counterpartyId: 'A', amount: '100', chainId: 8453, timestamp: 1000 });
      memory.record({ type: 'payment_received', counterpartyId: 'B', amount: '200', chainId: 43114, timestamp: 2000 });
      memory.record({ type: 'negotiation_proposed', counterpartyId: 'A', chainId: 8453, timestamp: 3000 });
      memory.record({ type: 'negotiation_rejected', counterpartyId: 'C', timestamp: 4000 });
      memory.record({ type: 'service_called', counterpartyId: 'A', chainId: 8453, timestamp: 5000 });
    });

    it('should return all interactions with no filter', () => {
      const results = memory.query();
      expect(results).toHaveLength(5);
    });

    it('should sort by most recent first', () => {
      const results = memory.query();
      expect(results[0].timestamp).toBe(5000);
      expect(results[4].timestamp).toBe(1000);
    });

    it('should filter by type', () => {
      const results = memory.query({ type: 'payment_sent' });
      expect(results).toHaveLength(1);
      expect(results[0].counterpartyId).toBe('A');
    });

    it('should filter by counterparty', () => {
      const results = memory.query({ counterpartyId: 'A' });
      expect(results).toHaveLength(3);
    });

    it('should filter by time range (since)', () => {
      const results = memory.query({ since: 3000 });
      expect(results).toHaveLength(3);
    });

    it('should filter by time range (until)', () => {
      const results = memory.query({ until: 2000 });
      expect(results).toHaveLength(2);
    });

    it('should filter by chain', () => {
      const results = memory.query({ chainId: 8453 });
      expect(results).toHaveLength(3);
    });

    it('should respect limit', () => {
      const results = memory.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('should combine filters (AND logic)', () => {
      const results = memory.query({ counterpartyId: 'A', chainId: 8453, since: 2000 });
      expect(results).toHaveLength(2); // negotiation_proposed (3000) and service_called (5000)
    });
  });

  describe('getRelationship()', () => {
    it('should return null for unknown agent', () => {
      expect(memory.getRelationship('unknown')).toBeNull();
    });

    it('should compute relationship with correct counts', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', amount: '100' });
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', amount: '200' });
      memory.record({ type: 'negotiation_rejected', counterpartyId: 'agent-1' });

      const rel = memory.getRelationship('agent-1');
      expect(rel).not.toBeNull();
      expect(rel!.totalInteractions).toBe(3);
      expect(rel!.successfulTransactions).toBe(2);
      expect(rel!.rejectedNegotiations).toBe(1);
      expect(rel!.totalVolume).toBe('300');
    });

    it('should compute average reputation', () => {
      memory.record({ type: 'reputation_submitted', counterpartyId: 'agent-1', reputationScore: 80 });
      memory.record({ type: 'reputation_submitted', counterpartyId: 'agent-1', reputationScore: 60 });

      const rel = memory.getRelationship('agent-1');
      expect(rel!.avgReputationGiven).toBe(70);
    });

    it('should track timestamps', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', timestamp: 1000 });
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', timestamp: 5000 });

      const rel = memory.getRelationship('agent-1');
      expect(rel!.firstInteraction).toBe(1000);
      expect(rel!.lastInteraction).toBe(5000);
    });

    it('should compute trust score between 0 and 100', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', amount: '100' });
      memory.record({ type: 'payment_sent', counterpartyId: 'agent-1', amount: '200' });

      const rel = memory.getRelationship('agent-1');
      expect(rel!.trustScore).toBeGreaterThanOrEqual(0);
      expect(rel!.trustScore).toBeLessThanOrEqual(100);
    });

    it('should penalize agents with many rejections', () => {
      // Good agent: all payments
      memory.record({ type: 'payment_sent', counterpartyId: 'good', amount: '100', reputationScore: 90 });
      memory.record({ type: 'payment_sent', counterpartyId: 'good', amount: '100', reputationScore: 90 });

      // Bad agent: mostly rejections
      memory.record({ type: 'negotiation_rejected', counterpartyId: 'bad' });
      memory.record({ type: 'negotiation_rejected', counterpartyId: 'bad' });

      const good = memory.getRelationship('good');
      const bad = memory.getRelationship('bad');
      expect(good!.trustScore).toBeGreaterThan(bad!.trustScore);
    });
  });

  describe('getAllRelationships()', () => {
    it('should return all known relationships sorted by trust', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'A', amount: '100', reputationScore: 95 });
      memory.record({ type: 'payment_sent', counterpartyId: 'A', amount: '100', reputationScore: 95 });
      memory.record({ type: 'negotiation_rejected', counterpartyId: 'B' });

      const rels = memory.getAllRelationships();
      expect(rels).toHaveLength(2);
      expect(rels[0].agentId).toBe('A'); // higher trust
      expect(rels[1].agentId).toBe('B'); // lower trust
    });
  });

  describe('getPreferredAgents()', () => {
    it('should rank agents by trust for a capability', () => {
      memory.record({
        type: 'service_called', counterpartyId: 'agent-1',
        metadata: { capability: 'code-audit' }, reputationScore: 90,
      });
      memory.record({
        type: 'payment_sent', counterpartyId: 'agent-1', amount: '100',
        metadata: { capability: 'code-audit' },
      });
      memory.record({
        type: 'service_called', counterpartyId: 'agent-2',
        metadata: { capability: 'code-audit' }, reputationScore: 50,
      });

      const preferred = memory.getPreferredAgents('audit');
      expect(preferred).toHaveLength(2);
      expect(preferred[0].agentId).toBe('agent-1'); // higher trust
    });

    it('should return empty for unknown capability', () => {
      memory.record({
        type: 'service_called', counterpartyId: 'agent-1',
        metadata: { capability: 'code-audit' },
      });
      expect(memory.getPreferredAgents('token-swap')).toHaveLength(0);
    });

    it('should be case-insensitive for capability', () => {
      memory.record({
        type: 'service_called', counterpartyId: 'agent-1',
        metadata: { capability: 'Code-Audit' },
      });
      expect(memory.getPreferredAgents('code-audit')).toHaveLength(1);
    });
  });

  describe('clear()', () => {
    it('should remove all interactions', () => {
      memory.record({ type: 'payment_sent', counterpartyId: 'A' });
      memory.record({ type: 'payment_sent', counterpartyId: 'B' });
      expect(memory.interactionCount).toBe(2);

      memory.clear();
      expect(memory.interactionCount).toBe(0);
      expect(memory.query()).toHaveLength(0);
    });
  });

  describe('file persistence', () => {
    const testFile = join(tmpdir(), `evalanche-memory-test-${Date.now()}.json`);

    afterEach(() => {
      try { unlinkSync(testFile); } catch { /* ignore */ }
    });

    it('should persist and reload interactions', () => {
      const mem1 = new AgentMemory(testFile);
      mem1.record({ type: 'payment_sent', counterpartyId: 'agent-1', amount: '100' });
      mem1.record({ type: 'service_called', counterpartyId: 'agent-2' });

      // Load from same file
      const mem2 = new AgentMemory(testFile);
      expect(mem2.interactionCount).toBe(2);

      const results = mem2.query({ counterpartyId: 'agent-1' });
      expect(results).toHaveLength(1);
      expect(results[0].amount).toBe('100');
    });

    it('should create file on first write', () => {
      const freshFile = join(tmpdir(), `evalanche-fresh-${Date.now()}.json`);
      try {
        const mem = new AgentMemory(freshFile);
        mem.record({ type: 'payment_sent', counterpartyId: 'test' });
        expect(existsSync(freshFile)).toBe(true);
      } finally {
        try { unlinkSync(freshFile); } catch { /* ignore */ }
      }
    });

    it('should handle clear with file persistence', () => {
      const mem = new AgentMemory(testFile);
      mem.record({ type: 'payment_sent', counterpartyId: 'A' });
      mem.clear();

      const reloaded = new AgentMemory(testFile);
      expect(reloaded.interactionCount).toBe(0);
    });
  });
});
