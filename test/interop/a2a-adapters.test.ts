import { describe, it, expect, vi } from 'vitest';
import {
  skillToAgentService,
  cardToAgentServices,
  cardToRegistration,
  createA2AProposal,
  mapTaskCompletion,
  handleTaskFailure,
  buildA2ADiscoveryQuery,
} from '../../src/interop/a2a-adapters';
import { NegotiationClient } from '../../src/economy/negotiation';
import type { AgentCard, A2ASkill, A2ATask } from '../../src/interop/schemas';

const SAMPLE_SKILL: A2ASkill = {
  id: 'audit',
  name: 'Smart Contract Audit',
  description: 'Audit Solidity contracts',
  tags: ['security', 'solidity'],
  inputModes: ['text'],
  outputModes: ['text'],
};

const SAMPLE_CARD: AgentCard = {
  name: 'TestAgent',
  description: 'Test agent for adapters',
  url: 'https://agent.example.com',
  version: '1.0.0',
  skills: [SAMPLE_SKILL],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  supportsStreaming: false,
};

describe('A2A Adapters', () => {
  // ── Skill → AgentService ──

  describe('skillToAgentService', () => {
    it('should map skill to AgentService', () => {
      const service = skillToAgentService(SAMPLE_SKILL, SAMPLE_CARD, 'agent_1');

      expect(service.agentId).toBe('agent_1');
      expect(service.capability).toBe('audit');
      expect(service.description).toContain('Smart Contract Audit');
      expect(service.endpoint).toBe('https://agent.example.com');
      expect(service.tags).toEqual(['security', 'solidity']);
    });
  });

  describe('cardToAgentServices', () => {
    it('should map all skills from a card', () => {
      const services = cardToAgentServices(SAMPLE_CARD, 'agent_1');

      expect(services).toHaveLength(1);
      expect(services[0].capability).toBe('audit');
    });
  });

  // ── Card → Registration ──

  describe('cardToRegistration', () => {
    it('should create registration from card', () => {
      const reg = cardToRegistration(SAMPLE_CARD, '0xWallet123');

      expect(reg.name).toBe('TestAgent');
      expect(reg.description).toBe('Test agent for adapters');
      expect(reg.agentWallet).toBe('0xWallet123');
      expect(reg.active).toBe(true);
      expect(reg.services).toHaveLength(1);
      expect(reg.services[0].name).toBe('A2A');
      expect(reg.services[0].endpoint).toBe('https://agent.example.com');
    });

    it('should use empty string for wallet when not provided', () => {
      const reg = cardToRegistration(SAMPLE_CARD);
      expect(reg.agentWallet).toBe('');
    });

    it('should detect x402 auth support', () => {
      const cardWithX402: AgentCard = {
        ...SAMPLE_CARD,
        authentication: { type: 'x402' },
      };
      const reg = cardToRegistration(cardWithX402);
      expect(reg.x402Support).toBe(true);
    });
  });

  // ── Task → Proposal ──

  describe('createA2AProposal', () => {
    it('should create a proposal via negotiation client', () => {
      const negotiation = new NegotiationClient();
      const proposalId = createA2AProposal(negotiation, {
        card: SAMPLE_CARD,
        skillId: 'audit',
        input: 'Audit this contract',
        price: '1000000000000000000',
        chainId: 8453,
        fromAgentId: 'buyer_1',
        toAgentId: 'seller_1',
      });

      expect(typeof proposalId).toBe('string');
      expect(proposalId).toMatch(/^prop_/);

      const proposal = negotiation.get(proposalId);
      expect(proposal?.task).toBe('a2a:audit');
      expect(proposal?.price).toBe('1000000000000000000');
      expect(proposal?.fromAgentId).toBe('buyer_1');
      expect(proposal?.toAgentId).toBe('seller_1');
    });
  });

  // ── Task Completion Mapping ──

  describe('mapTaskCompletion', () => {
    it('should preserve binary artifact data', () => {
      const task: A2ATask = {
        id: 'task_1',
        status: 'completed',
        messages: [],
        artifacts: [{ name: 'binary', mimeType: 'application/pdf', data: 'base64content==' }],
      };

      const result = mapTaskCompletion(task);
      expect(result.artifacts[0].data).toBe('base64content==');
      expect(result.artifacts[0].mimeType).toBe('application/pdf');
    });

    it('should map completed task', () => {
      const task: A2ATask = {
        id: 'task_1',
        status: 'completed',
        messages: [],
        artifacts: [{ name: 'report', mimeType: 'text/plain', text: 'All clear' }],
      };

      const result = mapTaskCompletion(task);
      expect(result.completed).toBe(true);
      expect(result.failed).toBe(false);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].text).toBe('All clear');
    });

    it('should map failed task', () => {
      const task: A2ATask = {
        id: 'task_1',
        status: 'failed',
        messages: [],
        artifacts: [],
        error: { code: 'HANDLER_ERROR', message: 'Something went wrong' },
      };

      const result = mapTaskCompletion(task);
      expect(result.completed).toBe(false);
      expect(result.failed).toBe(true);
      expect(result.error).toBe('Something went wrong');
    });

    it('should map canceled task as failed', () => {
      const task: A2ATask = {
        id: 'task_1',
        status: 'canceled',
        messages: [],
        artifacts: [],
      };

      const result = mapTaskCompletion(task);
      expect(result.completed).toBe(false);
      expect(result.failed).toBe(true);
    });

    it('should map in-progress task', () => {
      const task: A2ATask = {
        id: 'task_1',
        status: 'working',
        messages: [],
        artifacts: [],
      };

      const result = mapTaskCompletion(task);
      expect(result.completed).toBe(false);
      expect(result.failed).toBe(false);
    });
  });

  // ── Task Failure Handling ──

  describe('handleTaskFailure', () => {
    it('should reject proposal on failure', async () => {
      const negotiation = new NegotiationClient();
      const proposalId = negotiation.propose({
        fromAgentId: 'A',
        toAgentId: 'B',
        task: 'a2a:audit',
        price: '100',
        chainId: 1,
      });

      const task: A2ATask = {
        id: 'task_1',
        status: 'failed',
        messages: [],
        artifacts: [],
        error: { code: 'ERR', message: 'Failed' },
      };

      await handleTaskFailure(task, proposalId, negotiation);

      const proposal = negotiation.get(proposalId);
      expect(proposal?.status).toBe('rejected');
    });

    it('should not throw if proposal already rejected', async () => {
      const negotiation = new NegotiationClient();
      const proposalId = negotiation.propose({
        fromAgentId: 'A',
        toAgentId: 'B',
        task: 'test',
        price: '100',
        chainId: 1,
      });
      negotiation.reject(proposalId);

      const task: A2ATask = { id: 't', status: 'failed', messages: [], artifacts: [] };

      // Should not throw
      await handleTaskFailure(task, proposalId, negotiation);
    });

    it('should attempt escrow refund if provided', async () => {
      const negotiation = new NegotiationClient();
      const proposalId = negotiation.propose({
        fromAgentId: 'A',
        toAgentId: 'B',
        task: 'test',
        price: '100',
        chainId: 1,
      });

      const mockEscrow = { refund: vi.fn().mockResolvedValue(undefined) };
      const task: A2ATask = { id: 't', status: 'failed', messages: [], artifacts: [] };

      await handleTaskFailure(task, proposalId, negotiation, mockEscrow as any, 'job_1');

      expect(mockEscrow.refund).toHaveBeenCalledWith('job_1');
    });
  });

  // ── Discovery Query ──

  describe('buildA2ADiscoveryQuery', () => {
    it('should build empty query with no options', () => {
      const query = buildA2ADiscoveryQuery();
      expect(query).toEqual({});
    });

    it('should build query with capability', () => {
      const query = buildA2ADiscoveryQuery({ capability: 'audit' });
      expect(query.capability).toBe('audit');
    });

    it('should build query with tag', () => {
      const query = buildA2ADiscoveryQuery({ tag: 'security' });
      expect(query.tags).toEqual(['security']);
    });
  });
});
