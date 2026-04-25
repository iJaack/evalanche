/**
 * Interop Layer — barrel exports.
 *
 * ERC-8004 identity resolution, service endpoint discovery,
 * A2A protocol client/server, and cross-protocol agent interoperability.
 *
 * ```ts
 * import { InteropIdentityResolver, A2AClient, A2AServer } from 'evalanche/interop';
 * ```
 */

// Identity resolver
export { InteropIdentityResolver } from './identity';

// A2A Protocol
export { A2AClient } from './a2a';
export { A2AServer } from './a2a-server';
export type { SkillHandler, SkillResult, RegisteredSkill, A2AServerOptions } from './a2a-server';
export type { AuthPlacement, SubmitTaskOptions, TaskUpdateCallback } from './a2a';

// A2A ↔ Economy Adapters
export {
  skillToAgentService,
  cardToAgentServices,
  cardToRegistration,
  createA2AProposal,
  mapTaskCompletion,
  handleTaskFailure,
  buildA2ADiscoveryQuery,
} from './a2a-adapters';
export type { A2ATaskProposalParams } from './a2a-adapters';

// Shared types
export type {
  AgentRegistration,
  AgentServiceEntry,
  EndpointVerification,
  RegistrationBinding,
  ServiceEndpoints,
  TransportType,
  TrustMode,
  // A2A types
  AgentCard,
  A2ASkill,
  A2ATask,
  A2ATaskStatus,
  A2AMessage,
  A2AArtifact,
  A2AModality,
  A2AAuthentication,
} from './schemas';
