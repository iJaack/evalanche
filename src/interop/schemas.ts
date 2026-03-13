/**
 * Shared interop types for ERC-8004 identity resolution and
 * cross-protocol agent interoperability.
 */

/** Transport protocols supported by agent services */
export type TransportType = 'A2A' | 'XMTP' | 'MCP' | 'web' | 'ENS' | 'DID' | 'email';

/** Trust verification modes */
export type TrustMode = 'reputation' | 'crypto-economic' | 'tee-attestation';

/** A service endpoint advertised in an agent registration file */
export interface AgentServiceEntry {
  /** Service transport type */
  name: TransportType;
  /** URL or address for the service */
  endpoint: string;
  /** Optional version string */
  version?: string;
}

/** On-chain registration binding from the well-known file */
export interface RegistrationBinding {
  /** Agent registry contract address (CAIP-10 or raw 0x) */
  agentRegistry: string;
  /** Agent token ID */
  agentId: string;
}

/** Full ERC-8004 agent registration file shape */
export interface AgentRegistration {
  /** Agent display name */
  name: string;
  /** Short description of the agent */
  description: string;
  /** Agent wallet address for payments */
  agentWallet: string;
  /** Whether the agent is currently active */
  active: boolean;
  /** Service endpoints this agent exposes */
  services: AgentServiceEntry[];
  /** x402 payment support */
  x402Support?: boolean;
  /** Trust modes the agent supports */
  supportedTrust?: TrustMode[];
  /** Domain-registry bindings for endpoint verification */
  registrations?: RegistrationBinding[];
}

/** Typed map of service endpoints keyed by transport type */
export type ServiceEndpoints = Partial<Record<TransportType, string>>;

/** Result of verifying an endpoint domain binding */
export interface EndpointVerification {
  /** Whether the endpoint is verified */
  verified: boolean;
  /** Reason for failure, if not verified */
  reason?: string;
}
