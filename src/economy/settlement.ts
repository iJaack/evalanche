import type { AgentSigner } from '../wallet/signer';
import { TransactionBuilder } from '../wallet/transaction';
import { ReputationReporter } from '../reputation/reporter';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { NegotiationClient, Proposal } from './negotiation';

/** Parameters for settling an accepted proposal */
export interface SettlementParams {
  /** Proposal ID to settle */
  proposalId: string;
  /** Reputation score to give the counterparty (0-100) */
  reputationScore: number;
  /** Optional metadata for the reputation feedback */
  metadata?: Record<string, unknown>;
}

/** Result of a settlement */
export interface SettlementResult {
  /** The settled proposal */
  proposal: Proposal;
  /** Payment transaction hash */
  paymentTxHash: string;
  /** Reputation feedback transaction hash (null if feedback fails) */
  reputationTxHash: string | null;
  /** The price that was paid (agreed price from negotiation) */
  paidAmount: string;
}

/**
 * SettlementClient executes the atomic pay + rate flow for accepted proposals.
 *
 * Flow:
 * 1. Get the accepted proposal and its agreed price
 * 2. Send payment to the seller's address
 * 3. Submit reputation feedback on-chain
 * 4. Mark the proposal as settled
 *
 * Usage:
 * ```ts
 * const settlement = new SettlementClient(wallet, negotiation);
 * const result = await settlement.settle({
 *   proposalId: 'prop_1',
 *   reputationScore: 85,
 * });
 * ```
 */
export class SettlementClient {
  private readonly _wallet: AgentSigner;
  private readonly _txBuilder: TransactionBuilder;
  private readonly _reputation: ReputationReporter;
  private readonly _negotiation: NegotiationClient;

  constructor(wallet: AgentSigner, negotiation: NegotiationClient) {
    this._wallet = wallet;
    this._txBuilder = new TransactionBuilder(wallet);
    this._reputation = new ReputationReporter(wallet);
    this._negotiation = negotiation;
  }

  /**
   * Settle an accepted proposal: pay the seller and submit reputation feedback.
   *
   * Payment is required — if it fails, the entire settlement fails.
   * Reputation feedback is best-effort — if it fails, settlement still succeeds
   * (the payment went through, which is the critical part).
   */
  async settle(params: SettlementParams): Promise<SettlementResult> {
    const proposal = this._negotiation.get(params.proposalId);
    if (!proposal) {
      throw new EvalancheError(
        `Proposal ${params.proposalId} not found`,
        EvalancheErrorCode.SETTLEMENT_ERROR,
      );
    }

    if (proposal.status !== 'accepted') {
      throw new EvalancheError(
        `Cannot settle proposal in '${proposal.status}' state — must be accepted`,
        EvalancheErrorCode.SETTLEMENT_ERROR,
      );
    }

    const agreedPrice = this._negotiation.getAgreedPrice(params.proposalId);

    // Step 1: Send payment to the seller
    // The price is in wei, but TransactionBuilder.send() expects human-readable ETH.
    // We pass it as raw data to avoid conversion issues.
    let paymentTxHash: string;
    try {
      const { formatEther } = await import('ethers');
      const humanReadable = formatEther(BigInt(agreedPrice));
      const txResult = await this._txBuilder.send({
        to: proposal.toAgentId, // In a full implementation, resolve agentId → address
        value: humanReadable,
      });
      paymentTxHash = txResult.hash;
    } catch (error) {
      throw new EvalancheError(
        `Settlement payment failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.SETTLEMENT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    // Step 2: Submit reputation feedback (best-effort)
    let reputationTxHash: string | null = null;
    try {
      reputationTxHash = await this._reputation.submitFeedback({
        targetAgentId: proposal.toAgentId,
        taskRef: proposal.id,
        score: params.reputationScore,
        metadata: {
          task: proposal.task,
          price: agreedPrice,
          ...params.metadata,
        },
      });
    } catch {
      // Reputation feedback is best-effort — don't fail the settlement
    }

    // Step 3: Mark proposal as settled
    const settled = this._negotiation.markSettled(params.proposalId);

    return {
      proposal: settled,
      paymentTxHash,
      reputationTxHash,
      paidAmount: agreedPrice,
    };
  }
}
