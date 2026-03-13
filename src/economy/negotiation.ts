import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** State of a proposal in the negotiation lifecycle */
export type ProposalStatus = 'pending' | 'accepted' | 'countered' | 'rejected' | 'settled' | 'expired';

/** A task proposal from one agent to another */
export interface Proposal {
  /** Unique proposal ID */
  id: string;
  /** Agent ID of the proposer (buyer) */
  fromAgentId: string;
  /** Agent ID of the target (seller) */
  toAgentId: string;
  /** Short description of the task */
  task: string;
  /** Offered price in wei */
  price: string;
  /** Chain ID for payment */
  chainId: number;
  /** Current status */
  status: ProposalStatus;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) when last updated */
  updatedAt: number;
  /** If countered, the counter-price in wei */
  counterPrice?: string;
  /** Expiry timestamp (ms) — proposals auto-expire */
  expiresAt: number;
}

/** Default proposal TTL: 1 hour */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * NegotiationClient manages the proposal lifecycle between agents.
 *
 * Flow:
 * 1. Agent A proposes a task to Agent B with a price
 * 2. Agent B can accept, counter (with a different price), or reject
 * 3. If countered, Agent A can accept the counter or reject
 * 4. Once accepted, the proposal moves to "accepted" and can be settled
 *
 * Usage:
 * ```ts
 * const negotiation = new NegotiationClient();
 *
 * // Agent A proposes
 * const id = negotiation.propose({ fromAgentId: 'A', toAgentId: 'B', task: 'audit', price: '100', chainId: 8453 });
 *
 * // Agent B accepts
 * negotiation.accept(id);
 *
 * // After work is done, mark as settled
 * negotiation.markSettled(id);
 * ```
 */
export class NegotiationClient {
  private readonly _proposals: Map<string, Proposal> = new Map();
  private _nextId = 1;

  /**
   * Create a new task proposal.
   * @returns The proposal ID
   */
  propose(params: {
    fromAgentId: string;
    toAgentId: string;
    task: string;
    price: string;
    chainId: number;
    ttlMs?: number;
  }): string {
    if (!params.fromAgentId || !params.toAgentId || !params.task || !params.price) {
      throw new EvalancheError(
        'Proposal requires fromAgentId, toAgentId, task, and price',
        EvalancheErrorCode.NEGOTIATION_ERROR,
      );
    }

    const now = Date.now();
    const id = `prop_${this._nextId++}`;
    const proposal: Proposal = {
      id,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      task: params.task,
      price: params.price,
      chainId: params.chainId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + (params.ttlMs ?? DEFAULT_TTL_MS),
    };

    this._proposals.set(id, proposal);
    return id;
  }

  /**
   * Accept a proposal. Only the target agent should call this.
   */
  accept(proposalId: string): Proposal {
    const proposal = this._getActive(proposalId);

    if (proposal.status !== 'pending' && proposal.status !== 'countered') {
      throw new EvalancheError(
        `Cannot accept proposal in '${proposal.status}' state`,
        EvalancheErrorCode.NEGOTIATION_ERROR,
      );
    }

    proposal.status = 'accepted';
    proposal.updatedAt = Date.now();
    return { ...proposal };
  }

  /**
   * Counter a proposal with a different price. Only the target agent should call this.
   */
  counter(proposalId: string, counterPrice: string): Proposal {
    const proposal = this._getActive(proposalId);

    if (proposal.status !== 'pending') {
      throw new EvalancheError(
        `Cannot counter proposal in '${proposal.status}' state`,
        EvalancheErrorCode.NEGOTIATION_ERROR,
      );
    }

    proposal.status = 'countered';
    proposal.counterPrice = counterPrice;
    proposal.updatedAt = Date.now();
    return { ...proposal };
  }

  /**
   * Reject a proposal. Either party can reject.
   */
  reject(proposalId: string): Proposal {
    const proposal = this._getActive(proposalId);

    if (proposal.status === 'settled' || proposal.status === 'rejected') {
      throw new EvalancheError(
        `Cannot reject proposal in '${proposal.status}' state`,
        EvalancheErrorCode.NEGOTIATION_ERROR,
      );
    }

    proposal.status = 'rejected';
    proposal.updatedAt = Date.now();
    return { ...proposal };
  }

  /**
   * Mark a proposal as settled (payment completed + work delivered).
   * Call this after executing the settlement flow.
   */
  markSettled(proposalId: string): Proposal {
    const proposal = this._get(proposalId);

    if (proposal.status !== 'accepted') {
      throw new EvalancheError(
        `Cannot settle proposal in '${proposal.status}' state — must be accepted first`,
        EvalancheErrorCode.NEGOTIATION_ERROR,
      );
    }

    proposal.status = 'settled';
    proposal.updatedAt = Date.now();
    return { ...proposal };
  }

  /** Get a proposal by ID */
  get(proposalId: string): Proposal | undefined {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) return undefined;

    // Check expiry
    if (proposal.status === 'pending' && Date.now() > proposal.expiresAt) {
      proposal.status = 'expired';
      proposal.updatedAt = Date.now();
    }

    return { ...proposal };
  }

  /** List all proposals, optionally filtered by status */
  list(filter?: { status?: ProposalStatus; agentId?: string }): Proposal[] {
    const results: Proposal[] = [];
    for (const proposal of this._proposals.values()) {
      // Check expiry
      if (proposal.status === 'pending' && Date.now() > proposal.expiresAt) {
        proposal.status = 'expired';
        proposal.updatedAt = Date.now();
      }

      if (filter?.status && proposal.status !== filter.status) continue;
      if (filter?.agentId && proposal.fromAgentId !== filter.agentId && proposal.toAgentId !== filter.agentId) continue;
      results.push({ ...proposal });
    }
    return results;
  }

  /** Get the agreed-upon price (counter price if countered, original otherwise) */
  getAgreedPrice(proposalId: string): string {
    const proposal = this._get(proposalId);
    return proposal.counterPrice ?? proposal.price;
  }

  private _get(proposalId: string): Proposal {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) {
      throw new EvalancheError(`Proposal ${proposalId} not found`, EvalancheErrorCode.NEGOTIATION_ERROR);
    }
    return proposal;
  }

  private _getActive(proposalId: string): Proposal {
    const proposal = this._get(proposalId);

    // Check expiry
    if (proposal.status === 'pending' && Date.now() > proposal.expiresAt) {
      proposal.status = 'expired';
      proposal.updatedAt = Date.now();
      throw new EvalancheError(`Proposal ${proposalId} has expired`, EvalancheErrorCode.NEGOTIATION_ERROR);
    }

    return proposal;
  }
}
