import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2AClient } from '../../src/interop/a2a';
import type { AgentCard } from '../../src/interop/schemas';

const SAMPLE_CARD: AgentCard = {
  name: 'TestAgent',
  description: 'A test A2A agent',
  url: 'https://agent.example.com',
  version: '1.0.0',
  skills: [
    {
      id: 'audit',
      name: 'Smart Contract Audit',
      description: 'Audit Solidity contracts for vulnerabilities',
      tags: ['security', 'solidity'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
    {
      id: 'summarize',
      name: 'Summarize',
      description: 'Summarize text documents',
      tags: ['nlp'],
    },
  ],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  supportsStreaming: false,
};

const SAMPLE_TASK = {
  id: 'task_abc123',
  status: 'working' as const,
  messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'Audit this contract' }] }],
  artifacts: [],
};

describe('A2AClient', () => {
  let client: A2AClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    client = new A2AClient({ fetch: mockFetch as unknown as typeof fetch });
  });

  // ── Agent Card ──

  describe('fetchAgentCard', () => {
    it('should fetch and validate an agent card', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => SAMPLE_CARD,
      });

      const card = await client.fetchAgentCard('https://agent.example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://agent.example.com/.well-known/agent-card.json',
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
      expect(card.name).toBe('TestAgent');
      expect(card.skills).toHaveLength(2);
      expect(card.skills[0].id).toBe('audit');
    });

    it('should strip trailing slashes from base URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => SAMPLE_CARD,
      });

      await client.fetchAgentCard('https://agent.example.com///');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://agent.example.com/.well-known/agent-card.json',
        expect.any(Object),
      );
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(client.fetchAgentCard('https://bad.example.com'))
        .rejects.toThrow('Agent card not found');
    });

    it('should throw on invalid JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new Error('bad json'); },
      });

      await expect(client.fetchAgentCard('https://agent.example.com'))
        .rejects.toThrow('Invalid JSON');
    });

    it('should throw on missing name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'http://x', skills: [] }),
      });

      await expect(client.fetchAgentCard('https://agent.example.com'))
        .rejects.toThrow('missing name');
    });

    it('should throw on missing skills array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'X', url: 'http://x' }),
      });

      await expect(client.fetchAgentCard('https://agent.example.com'))
        .rejects.toThrow('missing skills');
    });
  });

  describe('resolveAgentCardFromERC8004', () => {
    it('should throw without identity resolver', async () => {
      await expect(client.resolveAgentCardFromERC8004('123'))
        .rejects.toThrow('InteropIdentityResolver required');
    });
  });

  // ── Skills ──

  describe('listSkills', () => {
    it('should return skills from a card', () => {
      const skills = client.listSkills(SAMPLE_CARD);
      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe('Smart Contract Audit');
    });
  });

  describe('findSkill', () => {
    it('should find skill by id', () => {
      const skill = client.findSkill(SAMPLE_CARD, { id: 'audit' });
      expect(skill?.name).toBe('Smart Contract Audit');
    });

    it('should find skill by tag', () => {
      const skill = client.findSkill(SAMPLE_CARD, { tag: 'nlp' });
      expect(skill?.id).toBe('summarize');
    });

    it('should return undefined for no match', () => {
      expect(client.findSkill(SAMPLE_CARD, { id: 'nonexistent' })).toBeUndefined();
      expect(client.findSkill(SAMPLE_CARD, { tag: 'nonexistent' })).toBeUndefined();
    });

    it('should return undefined with no query', () => {
      expect(client.findSkill(SAMPLE_CARD, {})).toBeUndefined();
    });
  });

  // ── Task Lifecycle ──

  describe('submitTask', () => {
    it('should submit a task and return task object', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => SAMPLE_TASK,
      });

      const task = await client.submitTask('https://agent.example.com', {
        skillId: 'audit',
        input: 'Audit this contract',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://agent.example.com/tasks',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"skill_id":"audit"'),
        }),
      );
      expect(task.id).toBe('task_abc123');
      expect(task.status).toBe('working');
    });

    it('should include auth header when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => SAMPLE_TASK,
      });

      await client.submitTask('https://agent.example.com', {
        skillId: 'audit',
        input: 'test',
        auth: 'Bearer token123',
      });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe('Bearer token123');
    });

    it('should throw on submission failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      await expect(
        client.submitTask('https://agent.example.com', { skillId: 'x', input: 'y' }),
      ).rejects.toThrow('task submission failed');
    });
  });

  describe('getTask', () => {
    it('should fetch task by ID', async () => {
      const completedTask = { ...SAMPLE_TASK, status: 'completed', artifacts: [{ name: 'report', text: 'All good' }] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => completedTask,
      });

      const task = await client.getTask('https://agent.example.com', 'task_abc123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://agent.example.com/tasks/task_abc123',
        expect.any(Object),
      );
      expect(task.status).toBe('completed');
      expect(task.artifacts).toHaveLength(1);
    });

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(client.getTask('https://agent.example.com', 'bad_id'))
        .rejects.toThrow('not found');
    });
  });

  describe('cancelTask', () => {
    it('should cancel a task', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...SAMPLE_TASK, status: 'canceled' }),
      });

      const task = await client.cancelTask('https://agent.example.com', 'task_abc123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://agent.example.com/tasks/task_abc123/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(task.status).toBe('canceled');
    });

    it('should throw on cancel failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

      await expect(client.cancelTask('https://agent.example.com', 'task_abc123'))
        .rejects.toThrow('cancellation failed');
    });
  });
});
