/** Trust level derived from reputation score */
export type TrustLevel = 'high' | 'medium' | 'low' | 'unknown';

/** Resolved on-chain agent identity */
export interface AgentIdentity {
  /** Agent token ID */
  agentId: string;
  /** Registry address in CAIP-10 format (e.g. "eip155:43114:0x8004...") */
  agentRegistry: string;
  /** Owner address of the agent NFT, null if unresolvable */
  owner: string | null;
  /** Reputation score 0-100, null if unresolvable */
  reputationScore: number | null;
  /** Token metadata URI, null if unresolvable */
  metadataUri: string | null;
  /** Derived trust level */
  trustLevel: TrustLevel;
}

/** Configuration for identity resolution */
export interface IdentityConfig {
  agentId: string;
  /** Registry address (raw 0x or CAIP-10 format) */
  registry?: string;
  /** Chain ID for CAIP-10 formatting (default: 43114 for Avalanche) */
  chainId?: number;
}
