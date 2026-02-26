import { parseEther } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import type { PaymentRequirements } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Handles x402 facilitator interactions — creating and signing payments.
 */
export class X402Facilitator {
  private readonly wallet: AgentSigner;

  constructor(wallet: AgentSigner) {
    this.wallet = wallet;
  }

  /**
   * Create a signed payment proof for x402 requirements.
   * @param requirements - Payment requirements from the 402 response
   * @returns Base64-encoded signed payment proof
   */
  async createPaymentProof(requirements: PaymentRequirements): Promise<string> {
    try {
      const payload = {
        facilitator: requirements.facilitator,
        paymentAddress: requirements.paymentAddress,
        amount: requirements.amount,
        currency: requirements.currency,
        chainId: requirements.chainId,
        payer: this.wallet.address,
        timestamp: Date.now(),
      };

      const message = JSON.stringify(payload);
      const signature = await this.wallet.signMessage(message);

      const proof = Buffer.from(
        JSON.stringify({ payload, signature }),
      ).toString('base64');

      return proof;
    } catch (error) {
      throw new EvalancheError(
        'Failed to create x402 payment proof',
        EvalancheErrorCode.X402_PAYMENT_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Validate that payment requirements don't exceed the max payment amount.
   * @param requirements - Payment requirements
   * @param maxPayment - Maximum payment in human-readable units (e.g. '0.01')
   * @returns true if within limits
   */
  static validatePaymentLimit(requirements: PaymentRequirements, maxPayment: string): boolean {
    const required = parseEther(requirements.amount);
    const max = parseEther(maxPayment);
    return required <= max;
  }
}
