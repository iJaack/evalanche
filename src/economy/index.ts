/**
 * Agent Economy Layer — barrel exports.
 *
 * All economy submodules are re-exported here for convenient access:
 *
 * ```ts
 * import { PolicyEngine, DiscoveryClient, NegotiationClient, AgentMemory } from 'evalanche/economy';
 * ```
 */

// Types
export type {
  SpendingPolicy,
  AllowlistEntry,
  SpendRecord,
  BudgetStatus,
  PolicyEvaluation,
  PolicyViolationType,
  PendingTransaction,
  AgentService,
  DiscoveryQuery,
  AgentProfile,
} from './types';

// Policies
export { PolicyEngine } from './policies';

// Transaction Simulation
export { simulateTransaction } from './simulation';
export type { SimulationResult } from './simulation';

// Discovery
export { DiscoveryClient } from './discovery';

// Service Host (x402 server-side)
export { AgentServiceHost } from './service';

// Negotiation
export { NegotiationClient } from './negotiation';
export type { Proposal, ProposalStatus } from './negotiation';

// Settlement
export { SettlementClient } from './settlement';

// Escrow
export { EscrowClient } from './escrow';
export type { EscrowInfo, EscrowStatus, EscrowDepositResult, EscrowTxResult } from './escrow';

// Memory
export { AgentMemory } from './memory';
export type {
  InteractionRecord,
  InteractionType,
  AgentRelationship,
  MemoryQuery,
} from './memory';
