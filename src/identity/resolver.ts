import { Contract, JsonRpcProvider } from 'ethers';
import { IDENTITY_ABI, IDENTITY_REGISTRY, REPUTATION_ABI, REPUTATION_REGISTRY } from './constants';
import type { AgentIdentity, IdentityConfig, TrustLevel } from './types';
import { TTLCache } from '../utils/cache';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Resolves ERC-8004 agent identities from on-chain registries.
 */
export class IdentityResolver {
  private readonly provider: JsonRpcProvider;
  private readonly config: IdentityConfig;
  private readonly identityContract: Contract;
  private readonly reputationContract: Contract;
  private readonly cache: TTLCache<AgentIdentity>;

  constructor(provider: JsonRpcProvider, config: IdentityConfig) {
    this.provider = provider;
    this.config = config;
    this.cache = new TTLCache<AgentIdentity>(5 * 60 * 1000); // 5 minute TTL

    const registryAddress = config.registry ?? IDENTITY_REGISTRY;
    this.identityContract = new Contract(registryAddress, IDENTITY_ABI, this.provider);
    this.reputationContract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, this.provider);
  }

  /**
   * Derive trust level from a reputation score.
   * @param score - Reputation score (0-100)
   * @returns Trust level: high (>=75), medium (>=40), or low (<40)
   */
  static deriveTrustLevel(score: number): TrustLevel {
    if (score >= 75) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  /**
   * Resolve the full on-chain identity for the configured agent.
   * Results are cached for 5 minutes.
   * @returns Resolved agent identity
   */
  async resolve(): Promise<AgentIdentity> {
    const cacheKey = `identity:${this.config.agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const agentId = this.config.agentId;
      const [tokenURI, owner, reputationRaw] = await Promise.all([
        this.identityContract.tokenURI(agentId) as Promise<string>,
        this.identityContract.ownerOf(agentId) as Promise<string>,
        this.reputationContract.getReputation(agentId).catch(() => BigInt(0)) as Promise<bigint>,
      ]);

      const reputation = Number(reputationRaw);
      const identity: AgentIdentity = {
        agentId,
        registry: this.config.registry ?? IDENTITY_REGISTRY,
        owner,
        tokenURI,
        reputation,
        trustLevel: IdentityResolver.deriveTrustLevel(reputation),
      };

      this.cache.set(cacheKey, identity);
      return identity;
    } catch (error) {
      throw new EvalancheError(
        `Failed to resolve identity for agent ${this.config.agentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
