/**
 * A2A ↔ Evalanche Economy Adapters
 *
 * Maps A2A protocol concepts to evalanche economy primitives:
 * - Agent Card skills → DiscoveryClient AgentService shape
 * - A2A task submission → NegotiationClient.propose()
 * - A2A task completion → settlement trigger
 * - A2A task failure → negotiation rejection + escrow refund
 * - AgentCard → AgentRegistration bridge
 */
import type { AgentService, DiscoveryQuery } from '../economy/types';
import type { NegotiationClient } from '../economy/negotiation';
import type { EscrowClient } from '../economy/escrow';
import type {
  AgentCard,
  A2ASkill,
  A2ATask,
  AgentRegistration,
  AgentServiceEntry,
} from './schemas';

// ── Agent Card → Discovery Mapping ──

/**
 * Convert an A2A Agent Card skill into an evalanche AgentService shape.
 * This allows A2A-discovered agents to appear in evalanche's DiscoveryClient.
 */
export function skillToAgentService(
  skill: A2ASkill,
  card: AgentCard,
  agentId: string,
): AgentService {
  return {
    agentId,
    capability: skill.id,
    description: `${skill.name}: ${skill.description}`,
    endpoint: card.url,
    pricePerCall: '0',
    chainId: 1,
    registeredAt: Date.now(),
    tags: skill.tags ?? [],
  };
}

/**
 * Convert all skills from an Agent Card into evalanche AgentService entries.
 */
export function cardToAgentServices(card: AgentCard, agentId: string): AgentService[] {
  return card.skills.map((skill) => skillToAgentService(skill, card, agentId));
}

/**
 * Bridge an A2A AgentCard to an ERC-8004 AgentRegistration shape.
 * Useful for treating A2A and ERC-8004 as interchangeable discovery sources.
 */
export function cardToRegistration(card: AgentCard, walletAddress?: string): AgentRegistration {
  const services: AgentServiceEntry[] = [
    { name: 'A2A', endpoint: card.url, version: card.version },
  ];

  return {
    name: card.name,
    description: card.description ?? '',
    agentWallet: walletAddress ?? '',
    active: true,
    services,
    x402Support: card.authentication?.type === 'x402',
    supportedTrust: [],
    registrations: [],
  };
}

// ── Task → Negotiation Mapping ──

/** Parameters for creating a negotiation proposal from an A2A task */
export interface A2ATaskProposalParams {
  /** The agent card of the target agent */
  card: AgentCard;
  /** The skill to invoke */
  skillId: string;
  /** Task input text */
  input: string;
  /** Proposed price in wei */
  price: string;
  /** Chain ID for payment */
  chainId: number;
  /** ID of the proposing agent */
  fromAgentId: string;
  /** ID of the target agent */
  toAgentId: string;
  /** TTL for the proposal in ms */
  ttlMs?: number;
}

/**
 * Create a negotiation proposal backed by an A2A task intent.
 * Encodes both the skill ID and the submitted input into the task field
 * so downstream settlement/failure handling can trace what was purchased.
 *
 * Returns the proposal ID — use it to track the proposal lifecycle.
 */
export function createA2AProposal(
  negotiation: NegotiationClient,
  params: A2ATaskProposalParams,
): string {
  // Encode full task intent: skill + input, JSON-serialized for deterministic parsing
  const taskDescriptor = JSON.stringify({
    protocol: 'a2a',
    skillId: params.skillId,
    input: params.input,
    agentUrl: params.card.url,
  });

  return negotiation.propose({
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    task: taskDescriptor,
    price: params.price,
    chainId: params.chainId,
    ttlMs: params.ttlMs,
  });
}

// ── Task Completion → Settlement ──

/**
 * Handle A2A task completion — triggers settlement if proposal exists.
 *
 * When an A2A task completes successfully with artifacts,
 * this maps it to the evalanche settlement flow.
 */
export function mapTaskCompletion(task: A2ATask): {
  completed: boolean;
  failed: boolean;
  artifacts: Array<{ name?: string; mimeType?: string; text?: string; data?: string; uri?: string }>;
  error?: string;
} {
  const completed = task.status === 'completed';
  const failed = task.status === 'failed' || task.status === 'canceled';

  return {
    completed,
    failed,
    artifacts: task.artifacts.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      text: a.text,
      data: a.data,
      uri: a.uri,
    })),
    error: task.error?.message,
  };
}

/**
 * Handle A2A task failure — reject negotiation and refund escrow if funded.
 */
export async function handleTaskFailure(
  task: A2ATask,
  proposalId: string,
  negotiation: NegotiationClient,
  escrow?: EscrowClient,
  jobId?: string,
): Promise<void> {
  // Reject the negotiation
  try {
    negotiation.reject(proposalId);
  } catch {
    // May already be in a terminal state — that's fine
  }

  // Refund escrow if it was funded
  if (escrow && jobId) {
    try {
      await escrow.refund(jobId);
    } catch {
      // Escrow may not exist or already be released
    }
  }
}

// ── Discovery Query Helpers ──

/**
 * Build a DiscoveryQuery that matches A2A-sourced services.
 */
export function buildA2ADiscoveryQuery(options?: {
  capability?: string;
  tag?: string;
  supportsStreaming?: boolean;
}): DiscoveryQuery {
  const query: DiscoveryQuery = {};

  if (options?.capability) {
    query.capability = options.capability;
  }

  if (options?.tag) {
    query.tags = [options.tag];
  }

  return query;
}
