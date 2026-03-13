/**
 * Interop Layer — barrel exports.
 *
 * ERC-8004 identity resolution, service endpoint discovery,
 * and cross-protocol agent interoperability.
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
