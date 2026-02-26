import type { AgentSigner } from '../wallet/signer';
import { X402Facilitator } from './facilitator';
import type { PaymentRequirements, PayAndFetchOptions, PayAndFetchResult } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * x402 payment-gated HTTP client.
 * Handles the full x402 flow: request → 402 → pay → retry.
 */
export class X402Client {
  private readonly wallet: AgentSigner;
  private readonly facilitator: X402Facilitator;

  constructor(wallet: AgentSigner) {
    this.wallet = wallet;
    this.facilitator = new X402Facilitator(wallet);
  }

  /**
   * Parse x402 payment requirements from a 402 response.
   * @param headers - Response headers from the 402 response
   * @returns Parsed payment requirements
   */
  static parsePaymentRequirements(headers: Headers): PaymentRequirements {
    const requirementsHeader = headers.get('x-payment-requirements') ?? headers.get('x-402-requirements');
    if (!requirementsHeader) {
      throw new EvalancheError(
        'No payment requirements found in 402 response headers',
        EvalancheErrorCode.X402_PAYMENT_FAILED,
      );
    }

    try {
      return JSON.parse(requirementsHeader) as PaymentRequirements;
    } catch {
      throw new EvalancheError(
        'Failed to parse x402 payment requirements',
        EvalancheErrorCode.X402_PAYMENT_FAILED,
      );
    }
  }

  /**
   * Make a payment-gated HTTP request using the x402 protocol.
   *
   * Flow:
   * 1. Make initial request
   * 2. If 402 Payment Required, parse requirements
   * 3. Validate payment doesn't exceed maxPayment
   * 4. Create signed payment proof
   * 5. Retry with payment proof in header
   *
   * @param url - URL to fetch
   * @param options - Payment and request options
   * @returns Response with status, headers, body, and optional payment hash
   */
  async payAndFetch(url: string, options: PayAndFetchOptions): Promise<PayAndFetchResult> {
    try {
      // Step 1: Initial request
      const initialResponse = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
      });

      // If not 402, return as-is
      if (initialResponse.status !== 402) {
        return {
          status: initialResponse.status,
          headers: Object.fromEntries(initialResponse.headers.entries()),
          body: await initialResponse.text(),
        };
      }

      // Step 2: Parse payment requirements
      const requirements = X402Client.parsePaymentRequirements(initialResponse.headers);

      // Step 3: Validate payment limit
      if (!X402Facilitator.validatePaymentLimit(requirements, options.maxPayment)) {
        throw new EvalancheError(
          `Payment of ${requirements.amount} ${requirements.currency} exceeds max of ${options.maxPayment}`,
          EvalancheErrorCode.X402_PAYMENT_EXCEEDED,
        );
      }

      // Step 4: Create payment proof
      const proof = await this.facilitator.createPaymentProof(requirements);

      // Step 5: Retry with payment proof
      const paidResponse = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          'x-payment-proof': proof,
        },
        body: options.body,
      });

      return {
        status: paidResponse.status,
        headers: Object.fromEntries(paidResponse.headers.entries()),
        body: await paidResponse.text(),
        paymentHash: proof,
      };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `x402 pay-and-fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.X402_PAYMENT_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
