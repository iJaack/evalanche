/**
 * Identity Module — ERC-8004 identity resolution for autonomous agents.
 *
 * ERC-8004 defines a standard for on-chain agent identity and service endpoints.
 * This module provides resolution and verification of agent identities.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-8004
 */

export { InteropIdentityResolver } from './erc8004';
export type {
  AgentRegistration,
  AgentServiceEntry,
  EndpointVerification,
  RegistrationBinding,
  ServiceEndpoints,
  TransportType,
  TrustMode,
} from './schemas';
