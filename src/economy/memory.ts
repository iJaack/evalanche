import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Types of interaction that get recorded in memory */
export type InteractionType =
  | 'payment_sent'
  | 'payment_received'
  | 'negotiation_proposed'
  | 'negotiation_accepted'
  | 'negotiation_rejected'
  | 'negotiation_countered'
  | 'service_called'
  | 'reputation_submitted';

/** A single recorded interaction with another agent */
export interface InteractionRecord {
  /** Unique interaction ID */
  id: string;
  /** Type of interaction */
  type: InteractionType;
  /** The other agent involved */
  counterpartyId: string;
  /** Amount in wei (for payments) */
  amount?: string;
  /** Chain ID where this occurred */
  chainId?: number;
  /** Transaction hash (for on-chain events) */
  txHash?: string;
  /** Free-form metadata (task description, capability, etc.) */
  metadata?: Record<string, unknown>;
  /** Reputation score given (0-100) */
  reputationScore?: number;
  /** Unix timestamp (ms) */
  timestamp: number;
}

/** Aggregated relationship with a specific agent */
export interface AgentRelationship {
  /** The counterparty agent ID */
  agentId: string;
  /** Total number of interactions */
  totalInteractions: number;
  /** Number of successful transactions (payments sent or received) */
  successfulTransactions: number;
  /** Number of rejected negotiations */
  rejectedNegotiations: number;
  /** Total volume transacted in wei */
  totalVolume: string;
  /** Average reputation score given to this agent (null if never rated) */
  avgReputationGiven: number | null;
  /** First interaction timestamp */
  firstInteraction: number;
  /** Most recent interaction timestamp */
  lastInteraction: number;
  /** Computed trust score (0-100) based on history */
  trustScore: number;
}

/** Filter options for querying interaction history */
export interface MemoryQuery {
  /** Filter by interaction type */
  type?: InteractionType;
  /** Filter by counterparty agent ID */
  counterpartyId?: string;
  /** Only interactions after this timestamp */
  since?: number;
  /** Only interactions before this timestamp */
  until?: number;
  /** Only interactions on this chain */
  chainId?: number;
  /** Maximum number of results (default: 50) */
  limit?: number;
}

/** Persistent memory store data (serialized to JSON) */
interface MemoryData {
  /** All interaction records */
  interactions: InteractionRecord[];
  /** Schema version for future migrations */
  version: number;
}

// ---------------------------------------------------------------------------
// AgentMemory
// ---------------------------------------------------------------------------

/**
 * Persistent memory for agent interactions.
 *
 * Stores a log of every economic interaction (payments, negotiations,
 * service calls, reputation feedback) and computes relationship summaries
 * from the raw history. Data is persisted to a JSON file so it survives
 * across sessions.
 *
 * @example
 * ```ts
 * const memory = new AgentMemory('./data/memory.json');
 *
 * memory.record({
 *   type: 'payment_sent',
 *   counterpartyId: 'agent-42',
 *   amount: '1000000000000000000',
 *   chainId: 8453,
 *   txHash: '0x...',
 * });
 *
 * const relationship = memory.getRelationship('agent-42');
 * console.log(relationship.trustScore); // 0-100
 * ```
 */
export class AgentMemory {
  private _data: MemoryData;
  private _filePath: string | null;
  private _counter = 0;

  /**
   * @param filePath - Path to persist memory data. Pass `null` for in-memory only (useful for tests).
   */
  constructor(filePath: string | null = null) {
    this._filePath = filePath;
    this._data = this._load();
  }

  /** Total number of recorded interactions */
  get interactionCount(): number {
    return this._data.interactions.length;
  }

  /**
   * Record a new interaction.
   *
   * @param record - Interaction details (id and timestamp are auto-filled if omitted)
   * @returns The generated interaction ID
   */
  record(record: Omit<InteractionRecord, 'id' | 'timestamp'> & { timestamp?: number }): string {
    const id = `ix_${Date.now()}_${this._counter++}`;
    const full: InteractionRecord = {
      ...record,
      id,
      timestamp: record.timestamp ?? Date.now(),
    };

    this._data.interactions.push(full);
    this._persist();
    return id;
  }

  /**
   * Query past interactions with optional filters.
   * Results are sorted by timestamp descending (most recent first).
   */
  query(filter?: MemoryQuery): InteractionRecord[] {
    let results = [...this._data.interactions];

    if (filter?.type) {
      results = results.filter((r) => r.type === filter.type);
    }
    if (filter?.counterpartyId) {
      results = results.filter((r) => r.counterpartyId === filter.counterpartyId);
    }
    if (filter?.since) {
      results = results.filter((r) => r.timestamp >= filter.since!);
    }
    if (filter?.until) {
      results = results.filter((r) => r.timestamp <= filter.until!);
    }
    if (filter?.chainId) {
      results = results.filter((r) => r.chainId === filter.chainId);
    }

    // Sort by most recent first
    results.sort((a, b) => b.timestamp - a.timestamp);

    const limit = filter?.limit ?? 50;
    return results.slice(0, limit);
  }

  /**
   * Get aggregated relationship data for a specific agent.
   * Returns null if no interactions exist with this agent.
   */
  getRelationship(agentId: string): AgentRelationship | null {
    const interactions = this._data.interactions.filter(
      (r) => r.counterpartyId === agentId,
    );

    if (interactions.length === 0) return null;

    let successfulTx = 0;
    let rejectedNeg = 0;
    let totalVolume = BigInt(0);
    let repSum = 0;
    let repCount = 0;
    let firstTs = Infinity;
    let lastTs = 0;

    for (const ix of interactions) {
      if (ix.type === 'payment_sent' || ix.type === 'payment_received') {
        successfulTx++;
        if (ix.amount) totalVolume += BigInt(ix.amount);
      }
      if (ix.type === 'negotiation_rejected') {
        rejectedNeg++;
      }
      if (ix.reputationScore !== undefined) {
        repSum += ix.reputationScore;
        repCount++;
      }
      if (ix.timestamp < firstTs) firstTs = ix.timestamp;
      if (ix.timestamp > lastTs) lastTs = ix.timestamp;
    }

    return {
      agentId,
      totalInteractions: interactions.length,
      successfulTransactions: successfulTx,
      rejectedNegotiations: rejectedNeg,
      totalVolume: totalVolume.toString(),
      avgReputationGiven: repCount > 0 ? Math.round(repSum / repCount) : null,
      firstInteraction: firstTs,
      lastInteraction: lastTs,
      trustScore: this._computeTrustScore(interactions.length, successfulTx, rejectedNeg, repCount > 0 ? repSum / repCount : null),
    };
  }

  /**
   * Get all known agent relationships, sorted by trust score descending.
   */
  getAllRelationships(): AgentRelationship[] {
    const agentIds = new Set<string>();
    for (const ix of this._data.interactions) {
      agentIds.add(ix.counterpartyId);
    }

    const relationships: AgentRelationship[] = [];
    for (const id of agentIds) {
      const rel = this.getRelationship(id);
      if (rel) relationships.push(rel);
    }

    relationships.sort((a, b) => b.trustScore - a.trustScore);
    return relationships;
  }

  /**
   * Get the best agents for a given capability, ranked by trust score.
   * Requires that interaction metadata includes a `capability` field.
   */
  getPreferredAgents(capability: string, limit = 5): AgentRelationship[] {
    // Find agents we've interacted with for this capability
    const agentIds = new Set<string>();
    for (const ix of this._data.interactions) {
      if (
        ix.metadata?.capability &&
        String(ix.metadata.capability).toLowerCase().includes(capability.toLowerCase())
      ) {
        agentIds.add(ix.counterpartyId);
      }
    }

    const relationships: AgentRelationship[] = [];
    for (const id of agentIds) {
      const rel = this.getRelationship(id);
      if (rel) relationships.push(rel);
    }

    relationships.sort((a, b) => b.trustScore - a.trustScore);
    return relationships.slice(0, limit);
  }

  /**
   * Clear all memory data. Use with caution.
   */
  clear(): void {
    this._data = { interactions: [], version: 1 };
    this._persist();
  }

  // ── Private helpers ──

  /**
   * Compute a trust score (0-100) from interaction history.
   *
   * Formula weights:
   * - 40% from success ratio (successful / total)
   * - 30% from average reputation score
   * - 20% from interaction volume (more interactions = more trust, up to 20 cap)
   * - 10% penalty for rejections
   */
  private _computeTrustScore(
    total: number,
    successful: number,
    rejected: number,
    avgReputation: number | null,
  ): number {
    if (total === 0) return 0;

    // Success ratio component (0-40)
    const successRatio = successful / total;
    const successComponent = successRatio * 40;

    // Reputation component (0-30)
    const repComponent = avgReputation !== null ? (avgReputation / 100) * 30 : 15; // default to neutral if never rated

    // Volume component (0-20) — logarithmic scale, caps at ~20 interactions
    const volumeComponent = Math.min(20, Math.log2(total + 1) * 5);

    // Rejection penalty (0 to -10)
    const rejectionRatio = total > 0 ? rejected / total : 0;
    const rejectionPenalty = rejectionRatio * 10;

    const score = Math.round(successComponent + repComponent + volumeComponent - rejectionPenalty);
    return Math.max(0, Math.min(100, score));
  }

  /** Load memory data from disk, or return empty state */
  private _load(): MemoryData {
    if (!this._filePath) {
      return { interactions: [], version: 1 };
    }

    try {
      if (existsSync(this._filePath)) {
        const raw = readFileSync(this._filePath, 'utf-8');
        const data = JSON.parse(raw) as MemoryData;
        // Set counter to avoid ID collisions with loaded data
        this._counter = data.interactions.length;
        return data;
      }
    } catch (err) {
      throw new EvalancheError(
        `Failed to load memory from ${this._filePath}: ${err instanceof Error ? err.message : String(err)}`,
        EvalancheErrorCode.MEMORY_ERROR,
      );
    }

    return { interactions: [], version: 1 };
  }

  /** Persist memory data to disk */
  private _persist(): void {
    if (!this._filePath) return;

    try {
      const dir = dirname(this._filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (err) {
      throw new EvalancheError(
        `Failed to persist memory to ${this._filePath}: ${err instanceof Error ? err.message : String(err)}`,
        EvalancheErrorCode.MEMORY_ERROR,
      );
    }
  }
}
