/**
 * Interop Layer — barrel exports.
 *
 * ERC-8004 identity resolution, service endpoint discovery,
 * cross-protocol agent interoperability and A2A 1.0 (JSON-RPC).
 *
 * ```ts
 * import { InteropIdentityResolver } from 'evalanche/interop';
 * ```
 */

// Identity resolver
export { InteropIdentityResolver } from './identity';

// Shared types
export type {
  AgentRegistration,
  AgentServiceEntry,
  EndpointVerification,
  RegistrationBinding,
  ServiceEndpoints,
  TransportType,
  TrustMode,
} from './schemas';

// A2A 1.0 (JSON-RPC binding)
export { A2AServer, A2ASkillError } from './a2a-server';
export type {
  A2APermission,
  A2APrincipal,
  A2AServerAuth,
  A2AServerLimits,
  A2AServerOptions,
  A2ASkill,
  A2ASkillContext,
  A2ASkillOutput,
  A2AStaticCredential,
} from './a2a-server';
export { A2AClient, A2AError } from './a2a-client';
export type { A2AClientOptions, A2ASendMessageInput } from './a2a-client';
export { A2A_AGENT_CARD_PATH, A2A_ERROR_CODES, A2A_PROTOCOL_VERSION, isA2ATerminalState } from './a2a-protocol';
export type {
  A2AAgentCard,
  A2AAgentInterface,
  A2AAgentSkill,
  A2AArtifact,
  A2AMessage,
  A2APart,
  A2ASendMessageResult,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
} from './a2a-protocol';
