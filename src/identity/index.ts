/**
 * Identity module exports.
 */

export { IdentityResolver } from './resolver';
export type { AgentIdentity, IdentityConfig, TrustLevel } from './types';
export { InteropIdentityResolver } from '../interop/identity';
export type {
  AgentRegistration,
  AgentServiceEntry,
  EndpointVerification,
  RegistrationBinding,
  ServiceEndpoints,
  TransportType,
  TrustMode,
} from '../interop/schemas';
