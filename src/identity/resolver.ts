import { Contract, JsonRpcProvider } from 'ethers';
import { IDENTITY_ABI, IDENTITY_REGISTRY, REPUTATION_ABI, REPUTATION_REGISTRY } from './constants';
import type { AgentIdentity, IdentityConfig, TrustLevel } from './types';
import { TTLCache } from '../utils/cache';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Resolves ERC-8004 agent identities from on-chain registries.
 * Uses the same contract interface and trust derivation as Core Extension.
 */
export class IdentityResolver {
  private readonly provider: JsonRpcProvider;
  private readonly config: IdentityConfig;
  private readonly identityContract: Contract;
  private readonly reputationContract: Contract;
  private readonly cache: TTLCache<AgentIdentity>;
  private readonly chainId: number;

  constructor(provider: JsonRpcProvider, config: IdentityConfig) {
    this.provider = provider;
    this.config = config;
    this.chainId = config.chainId ?? 43114;
    this.cache = new TTLCache<AgentIdentity>(5 * 60 * 1000); // 5 minute TTL

    const registryAddress = this.parseRegistryAddress(config.registry ?? IDENTITY_REGISTRY);
    this.identityContract = new Contract(registryAddress, IDENTITY_ABI, this.provider);
    this.reputationContract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, this.provider);
  }

  /**
   * Parse a registry address from either raw 0x format or CAIP-10 format.
   * @param registry - Registry address (0x... or eip155:chainId:0x...)
   * @returns Raw address
   */
  private parseRegistryAddress(registry: string): string {
    if (registry.startsWith('eip155:')) {
      const parts = registry.split(':');
      return parts[2] ?? registry;
    }
    return registry;
  }

  /**
   * Format a registry address in CAIP-10 format.
   * @param address - Raw 0x address
   * @returns CAIP-10 formatted string
   */
  private toCaip10(address: string): string {
    if (address.startsWith('eip155:')) return address;
    return `eip155:${this.chainId}:${address}`;
  }

  /**
   * Derive trust level from a reputation score.
   * Matches Core Extension thresholds: high (>=75), medium (>=40), low (<40), unknown (null).
   * @param score - Reputation score (0-100) or null
   * @returns Trust level
   */
  static deriveTrustLevel(score: number | null): TrustLevel {
    if (score === null) return 'unknown';
    if (score >= 75) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  /**
   * Resolve the full on-chain identity for the configured agent.
   * Results are cached for 5 minutes.
   * Uses Promise.allSettled so individual failures are non-blocking.
   * @returns Resolved agent identity
   */
  async resolve(): Promise<AgentIdentity> {
    const registryAddress = this.config.registry ?? IDENTITY_REGISTRY;
    const agentRegistry = this.toCaip10(this.parseRegistryAddress(registryAddress));
    const cacheKey = `${agentRegistry}:${this.config.agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const agentIdBigInt = BigInt(this.config.agentId);

      // Use Promise.allSettled so failures are non-blocking (matches Core Extension pattern)
      const [metadataResult, ownerResult, reputationResult] = await Promise.allSettled([
        this.identityContract.getFunction('tokenURI')(agentIdBigInt) as Promise<string>,
        this.identityContract.getFunction('ownerOf')(agentIdBigInt) as Promise<string>,
        this.reputationContract.getFunction('getReputation')(agentIdBigInt) as Promise<bigint>,
      ]);

      const metadataUri = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
      const owner = ownerResult.status === 'fulfilled' ? ownerResult.value : null;

      let reputationScore: number | null = null;
      if (reputationResult.status === 'fulfilled') {
        const score = Number(reputationResult.value);
        // Clamp to 0-100 range
        reputationScore = Math.max(0, Math.min(100, score));
      }

      const identity: AgentIdentity = {
        agentId: this.config.agentId,
        agentRegistry,
        owner,
        reputationScore,
        metadataUri,
        trustLevel: IdentityResolver.deriveTrustLevel(reputationScore),
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
