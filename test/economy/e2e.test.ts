/**
 * End-to-end integration test for the Agent Economy Layer.
 *
 * Simulates a full lifecycle:
 * Agent A discovers Agent B → negotiates price → pays → rates → remembers
 */
import { describe, it, expect, vi } from 'vitest';
import { DiscoveryClient } from '../../src/economy/discovery';
import { NegotiationClient } from '../../src/economy/negotiation';
import { AgentMemory } from '../../src/economy/memory';
import type { JsonRpcProvider } from 'ethers';

function mockProvider(): JsonRpcProvider {
  return {} as JsonRpcProvider;
}

describe('Agent Economy E2E', () => {
  it('full lifecycle: discover → negotiate → accept → record → trust', async () => {
    // --- Setup ---
    const discovery = new DiscoveryClient(mockProvider());
    const negotiation = new NegotiationClient();
    const memoryA = new AgentMemory(); // Agent A's memory
    const memoryB = new AgentMemory(); // Agent B's memory

    // --- Step 1: Agent B registers a service ---
    discovery.register({
      agentId: 'agent-B',
      capability: 'smart-contract-audit',
      description: 'Automated Solidity audit with vulnerability scoring',
      endpoint: 'https://agent-b.example.com/audit',
      pricePerCall: '500000000000000000', // 0.5 ETH
      chainId: 8453,
      registeredAt: Date.now(),
      tags: ['solidity', 'security', 'defi'],
    });

    // --- Step 2: Agent A searches for audit services ---
    const results = await discovery.search({
      capability: 'audit',
      chainIds: [8453],
      tags: ['solidity'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe('agent-B');

    const selectedService = results[0];

    // --- Step 3: Agent A proposes a negotiation ---
    const proposalId = negotiation.propose({
      fromAgentId: 'agent-A',
      toAgentId: selectedService.agentId,
      task: selectedService.capability,
      price: selectedService.pricePerCall,
      chainId: selectedService.chainId,
    });

    // Record negotiation in memory
    memoryA.record({
      type: 'negotiation_proposed',
      counterpartyId: 'agent-B',
      amount: selectedService.pricePerCall,
      chainId: 8453,
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    expect(negotiation.get(proposalId)?.status).toBe('pending');

    // --- Step 4: Agent B counters with a higher price ---
    negotiation.counter(proposalId, '750000000000000000'); // 0.75 ETH

    memoryB.record({
      type: 'negotiation_countered',
      counterpartyId: 'agent-A',
      amount: '750000000000000000',
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    expect(negotiation.get(proposalId)?.status).toBe('countered');
    expect(negotiation.getAgreedPrice(proposalId)).toBe('750000000000000000');

    // --- Step 5: Agent A accepts the counter ---
    const accepted = negotiation.accept(proposalId);
    expect(accepted.status).toBe('accepted');

    memoryA.record({
      type: 'negotiation_accepted',
      counterpartyId: 'agent-B',
      amount: '750000000000000000',
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    // --- Step 6: Simulate payment (we skip actual blockchain tx in this test) ---
    // In production, SettlementClient.settle() would handle this
    memoryA.record({
      type: 'payment_sent',
      counterpartyId: 'agent-B',
      amount: '750000000000000000',
      chainId: 8453,
      txHash: '0xfake_payment_hash',
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    memoryB.record({
      type: 'payment_received',
      counterpartyId: 'agent-A',
      amount: '750000000000000000',
      chainId: 8453,
      txHash: '0xfake_payment_hash',
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    // Mark as settled
    negotiation.markSettled(proposalId);
    expect(negotiation.get(proposalId)?.status).toBe('settled');

    // --- Step 7: Agent A submits reputation feedback ---
    memoryA.record({
      type: 'reputation_submitted',
      counterpartyId: 'agent-B',
      reputationScore: 92,
      metadata: { capability: 'smart-contract-audit', proposalId },
    });

    // --- Step 8: Verify Agent A's memory of Agent B ---
    const relA = memoryA.getRelationship('agent-B');
    expect(relA).not.toBeNull();
    expect(relA!.totalInteractions).toBe(4); // proposed, accepted, payment, reputation
    expect(relA!.successfulTransactions).toBe(1); // 1 payment
    expect(relA!.totalVolume).toBe('750000000000000000');
    expect(relA!.avgReputationGiven).toBe(92);
    expect(relA!.trustScore).toBeGreaterThan(0);

    // --- Step 9: Agent A queries preferred agents for future audits ---
    const preferred = memoryA.getPreferredAgents('audit');
    expect(preferred).toHaveLength(1);
    expect(preferred[0].agentId).toBe('agent-B');

    // --- Step 10: Agent B's perspective ---
    const relB = memoryB.getRelationship('agent-A');
    expect(relB).not.toBeNull();
    expect(relB!.totalInteractions).toBe(2); // countered, payment_received
    expect(relB!.successfulTransactions).toBe(1);
    expect(relB!.totalVolume).toBe('750000000000000000');

    // --- Step 11: Verify negotiation list shows settled ---
    const settled = negotiation.list({ status: 'settled' });
    expect(settled).toHaveLength(1);
    expect(settled[0].fromAgentId).toBe('agent-A');
    expect(settled[0].toAgentId).toBe('agent-B');
  });

  it('handles rejection flow gracefully', async () => {
    const negotiation = new NegotiationClient();
    const memory = new AgentMemory();

    const proposalId = negotiation.propose({
      fromAgentId: 'agent-X',
      toAgentId: 'agent-Y',
      task: 'token-analysis',
      price: '100000000000000000',
      chainId: 43114,
    });

    negotiation.reject(proposalId);
    expect(negotiation.get(proposalId)?.status).toBe('rejected');

    memory.record({
      type: 'negotiation_rejected',
      counterpartyId: 'agent-Y',
      metadata: { capability: 'token-analysis', proposalId },
    });

    const rel = memory.getRelationship('agent-Y');
    expect(rel!.rejectedNegotiations).toBe(1);
    expect(rel!.successfulTransactions).toBe(0);
    // Trust should be low due to 100% rejection rate
    expect(rel!.trustScore).toBeLessThan(50);
  });

  it('multi-agent discovery with memory-informed selection', async () => {
    const discovery = new DiscoveryClient(mockProvider());
    const memory = new AgentMemory();

    // Register multiple audit agents
    discovery.register({
      agentId: 'auditor-1', capability: 'audit', description: 'Fast auditor',
      endpoint: 'https://a1.example.com', pricePerCall: '100', chainId: 8453, registeredAt: Date.now(),
    });
    discovery.register({
      agentId: 'auditor-2', capability: 'audit', description: 'Thorough auditor',
      endpoint: 'https://a2.example.com', pricePerCall: '200', chainId: 8453, registeredAt: Date.now(),
    });

    // Agent has good history with auditor-2
    memory.record({ type: 'payment_sent', counterpartyId: 'auditor-2', amount: '200', reputationScore: 95, metadata: { capability: 'audit' } });
    memory.record({ type: 'payment_sent', counterpartyId: 'auditor-2', amount: '200', reputationScore: 90, metadata: { capability: 'audit' } });

    // Agent has bad history with auditor-1
    memory.record({ type: 'negotiation_rejected', counterpartyId: 'auditor-1', metadata: { capability: 'audit' } });

    // Discovery finds both, but memory tells us auditor-2 is preferred
    const discoveredAgents = await discovery.search({ capability: 'audit' });
    expect(discoveredAgents).toHaveLength(2);

    const preferred = memory.getPreferredAgents('audit');
    expect(preferred[0].agentId).toBe('auditor-2');
    expect(preferred[0].trustScore).toBeGreaterThan(preferred[1]?.trustScore ?? 0);
  });
});
