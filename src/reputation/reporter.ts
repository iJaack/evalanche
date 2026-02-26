import { Contract, solidityPackedKeccak256 } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import { REPUTATION_REGISTRY, REPUTATION_ABI, DOMAIN_SEPARATOR } from '../identity/constants';
import type { FeedbackSubmission } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Submits reputation feedback on-chain after agent interactions.
 */
export class ReputationReporter {
  private readonly wallet: AgentSigner;
  private readonly contract: Contract;

  constructor(wallet: AgentSigner) {
    this.wallet = wallet;
    this.contract = new Contract(REPUTATION_REGISTRY, REPUTATION_ABI, this.wallet);
  }

  /**
   * Compute the interaction hash for a feedback submission.
   * Hash = keccak256(DOMAIN_SEPARATOR || taskRef || dataHash)
   * @param taskRef - Task reference identifier
   * @param metadata - Optional metadata to include in hash
   * @returns bytes32 interaction hash
   */
  static computeInteractionHash(taskRef: string, metadata?: Record<string, unknown>): string {
    const dataHash = metadata ? JSON.stringify(metadata) : '';
    return solidityPackedKeccak256(
      ['string', 'string', 'string'],
      [DOMAIN_SEPARATOR, taskRef, dataHash],
    );
  }

  /**
   * Submit reputation feedback on-chain.
   * @param feedback - Feedback details including target agent, task ref, and score
   * @returns Transaction hash
   */
  async submitFeedback(feedback: FeedbackSubmission): Promise<string> {
    try {
      const interactionHash = ReputationReporter.computeInteractionHash(
        feedback.taskRef,
        feedback.metadata,
      );

      const tx = await this.contract.submitFeedback(
        feedback.targetAgentId,
        interactionHash,
        feedback.score,
      );
      const receipt = await tx.wait();
      return receipt.hash as string;
    } catch (error) {
      throw new EvalancheError(
        `Failed to submit reputation feedback: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.REPUTATION_SUBMIT_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
