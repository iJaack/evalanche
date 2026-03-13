import type { JsonRpcProvider } from 'ethers';
import { IdentityResolver } from '../identity/resolver';
import type { AgentIdentity } from '../identity/types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { AgentService, DiscoveryQuery, AgentProfile } from './types';

/**
 * DiscoveryClient enables agents to register their services and
 * discover other agents by capability, reputation, or price.
 *
 * Currently uses an in-memory registry. The interface is designed for
 * seamless migration to an on-chain or off-chain shared registry.
 *
 * Usage:
 * ```ts
 * const discovery = new DiscoveryClient(provider);
 *
 * // Register a service
 * discovery.register({
 *   agentId: '1599',
 *   capability: 'code-audit',
 *   description: 'Smart contract security audit',
 *   endpoint: 'https://agent1599.example.com/audit',
 *   pricePerCall: '10000000000000000', // 0.01 ETH
 *   chainId: 8453,
 *   registeredAt: Date.now(),
 * });
 *
 * // Search
 * const results = await discovery.search({ capability: 'code-audit', minReputation: 50 });
 * ```
 */
export class DiscoveryClient {
  private readonly _provider: JsonRpcProvider;
  private readonly _services: Map<string, AgentService[]> = new Map();

  constructor(provider: JsonRpcProvider) {
    this._provider = provider;
  }

  /**
   * Register a service offered by an agent.
   * If the agent already has a service with the same capability, it is replaced.
   */
  register(service: AgentService): void {
    if (!service.agentId || !service.capability || !service.endpoint) {
      throw new EvalancheError(
        'Service registration requires agentId, capability, and endpoint',
        EvalancheErrorCode.DISCOVERY_ERROR,
      );
    }

    const existing = this._services.get(service.agentId) ?? [];
    // Replace if same capability already registered
    const filtered = existing.filter((s) => s.capability !== service.capability);
    filtered.push({ ...service, registeredAt: service.registeredAt || Date.now() });
    this._services.set(service.agentId, filtered);
  }

  /**
   * Remove a specific service listing.
   * @returns true if found and removed, false if not found
   */
  unregister(agentId: string, capability: string): boolean {
    const existing = this._services.get(agentId);
    if (!existing) return false;

    const filtered = existing.filter((s) => s.capability !== capability);
    if (filtered.length === existing.length) return false;

    if (filtered.length === 0) {
      this._services.delete(agentId);
    } else {
      this._services.set(agentId, filtered);
    }
    return true;
  }

  /**
   * Search for agents matching a query.
   * Filters are applied with AND logic. Omit a filter to skip it.
   * Results are sorted by price (lowest first).
   *
   * If `minReputation` is set, each matching agent's reputation is resolved
   * from the on-chain ERC-8004 registry (requires network access).
   */
  async search(query: DiscoveryQuery = {}): Promise<AgentService[]> {
    const limit = query.limit ?? 10;
    let results: AgentService[] = [];

    // Collect all services across all agents
    for (const services of this._services.values()) {
      results.push(...services);
    }

    // Filter by capability (substring match, case-insensitive)
    if (query.capability) {
      const cap = query.capability.toLowerCase();
      results = results.filter((s) =>
        s.capability.toLowerCase().includes(cap),
      );
    }

    // Filter by chain
    if (query.chainIds && query.chainIds.length > 0) {
      results = results.filter((s) => query.chainIds!.includes(s.chainId));
    }

    // Filter by max price
    if (query.maxPrice) {
      const max = BigInt(query.maxPrice);
      results = results.filter((s) => BigInt(s.pricePerCall) <= max);
    }

    // Filter by tags (all tags must be present)
    if (query.tags && query.tags.length > 0) {
      const requiredTags = query.tags.map((t) => t.toLowerCase());
      results = results.filter((s) => {
        if (!s.tags) return false;
        const serviceTags = s.tags.map((t) => t.toLowerCase());
        return requiredTags.every((t) => serviceTags.includes(t));
      });
    }

    // Filter by reputation (requires on-chain lookup)
    if (query.minReputation !== undefined && query.minReputation > 0) {
      const minRep = query.minReputation;
      const reputationChecks = await Promise.allSettled(
        results.map(async (service) => {
          const resolver = new IdentityResolver(this._provider, { agentId: service.agentId });
          const identity = await resolver.resolve();
          return { service, reputation: identity.reputationScore };
        }),
      );

      results = reputationChecks
        .filter((r): r is PromiseFulfilledResult<{ service: AgentService; reputation: number | null }> =>
          r.status === 'fulfilled' && r.value.reputation !== null && r.value.reputation >= minRep,
        )
        .map((r) => r.value.service);
    }

    // Sort by price ascending (cheapest first)
    results.sort((a, b) => {
      const priceA = BigInt(a.pricePerCall);
      const priceB = BigInt(b.pricePerCall);
      if (priceA < priceB) return -1;
      if (priceA > priceB) return 1;
      return 0;
    });

    return results.slice(0, limit);
  }

  /**
   * Get the full profile of an agent: on-chain identity + registered services.
   * Combines ERC-8004 identity resolution with the local service registry.
   */
  async resolve(agentId: string): Promise<AgentProfile> {
    try {
      const resolver = new IdentityResolver(this._provider, { agentId });
      const identity: AgentIdentity = await resolver.resolve();

      return {
        agentId,
        owner: identity.owner,
        reputationScore: identity.reputationScore,
        trustLevel: identity.trustLevel,
        services: this._services.get(agentId) ?? [],
      };
    } catch (error) {
      // If identity can't be resolved, still return what we have from registry
      return {
        agentId,
        owner: null,
        reputationScore: null,
        trustLevel: 'unknown',
        services: this._services.get(agentId) ?? [],
      };
    }
  }

  /**
   * List all registered services (unfiltered).
   * Mainly useful for debugging and admin.
   */
  listAll(): AgentService[] {
    const all: AgentService[] = [];
    for (const services of this._services.values()) {
      all.push(...services);
    }
    return all;
  }

  /** Get number of registered agents */
  get agentCount(): number {
    return this._services.size;
  }

  /** Get total number of registered services */
  get serviceCount(): number {
    let count = 0;
    for (const services of this._services.values()) {
      count += services.length;
    }
    return count;
  }
}
