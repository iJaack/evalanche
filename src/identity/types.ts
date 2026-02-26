/** Trust level derived from reputation score */
export type TrustLevel = 'high' | 'medium' | 'low';

/** Resolved on-chain agent identity */
export interface AgentIdentity {
  agentId: string;
  registry: string;
  owner: string;
  tokenURI: string;
  reputation: number;
  trustLevel: TrustLevel;
}

/** Configuration for identity resolution */
export interface IdentityConfig {
  agentId: string;
  registry?: string;
}
